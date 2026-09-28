"""Pure, deterministic personal ranking. No I/O, credentials or remote calls."""
from __future__ import annotations

import math
from collections import Counter

ENGINE = "personal-content-v2"
CONTENT_VERSION = "content-evidence-v2"
DIMENSIONS = {
    "mechanism": "具体设定",
    "rule_scope": "规则改变范围",
    "development": "设定展开",
    "surprise": "意外展开",
    "atmosphere": "氛围张力",
    "formulaic": "明确套路评价",
    "visual_praise": "画面评价",
}


def rating_outcome(rating):
    """6 is below the like threshold, not a dislike or a hard constraint."""
    return (0.5 + (rating - 7) / 6) if rating >= 7 else (-0.25 - (6 - rating) * 0.15)


def cosine(a, b):
    if not a or not b or len(a) != len(b):
        return None
    norm = math.sqrt(sum(x*x for x in a) * sum(x*x for x in b))
    return sum(x*y for x, y in zip(a, b)) / norm if norm else None


def sigmoid(x):
    return 1 / (1 + math.exp(-max(-30, min(30, x))))


class PreferenceModel:
    """Balanced regularized logistic classifier with train-only preprocessing.

    Unknown semantic values are centered to zero, never interpreted as absence.
    Author/tag vocabulary and vector prototypes are learned only from training
    rows. Training prototypes exclude the current item to avoid self-matching.
    Scores are ranking utilities, not calibrated probabilities.
    """
    def __init__(self, rows, content, vectors, mode="combined"):
        self.rows = sorted((r for r in rows if r.get("rating") is not None), key=lambda r: r["id"])
        self.content, self.vectors, self.mode = content, vectors, mode
        self.prototypes = {}
        for row in self.rows if mode == "combined" else []:
            for modality, vector in vectors.get(row["id"], {}).items():
                key = (modality, len(vector), int(row["rating"] >= 7))
                total, count = self.prototypes.get(key, ([0.0]*len(vector), 0))
                self.prototypes[key] = ([a+b for a, b in zip(total, vector)], count+1)
        self.ratings = {r["id"]: r["rating"] for r in self.rows}
        self.tags = self._vocabulary("tags", 64, 1)
        self.authors = self._vocabulary("authors", 24, 2)
        self.names = []
        if mode != "metadata":
            self.names += ["content:" + k for k in DIMENSIONS]
        if mode != "content":
            self.names += ["tag:" + t for t in self.tags] + ["author:" + a for a in self.authors]
        if mode == "combined":
            self.names += ["vector:" + m for m in ("cover", "title", "joint")]
        raw = [self.features(row, exclude=row["id"]) for row in self.rows]
        self.means = {}
        for name in self.names:
            values = [r[name] for r in raw if r.get(name) is not None]
            self.means[name] = sum(values)/len(values) if values else 0.0
        matrix = [self.center(r) for r in raw]
        positive = sum(r["rating"] >= 7 for r in self.rows)
        self.counts = {"liked": positive, "six": sum(r["rating"] == 6 for r in self.rows),
                       "lower": sum(r["rating"] < 6 for r in self.rows)}
        self.weights = [0.0] * len(self.names)
        self.bias = 0.0
        self.trained = positive > 0 and positive < len(self.rows)
        if not self.trained:
            return
        labels = [int(r["rating"] >= 7) for r in self.rows]
        importance = [1 + (r["rating"] - 7) * 0.15 if r["rating"] >= 7 else
                      (1.25 if r["rating"] == 6 else 1.0) for r in self.rows]
        totals = [sum(w for w, y in zip(importance, labels) if y == c) for c in (0, 1)]
        importance = [w / (2 * totals[y]) for w, y in zip(importance, labels)]
        for _ in range(350):
            gradient = [0.0] * len(self.names)
            intercept = 0.0
            for x, y, importance_i in zip(matrix, labels, importance):
                error = (sigmoid(self.bias + sum(a*b for a, b in zip(x, self.weights))) - y) * importance_i
                intercept += error
                for j, value in enumerate(x):
                    gradient[j] += error * value
            self.bias -= 0.6 * intercept
            self.weights = [w - 0.6 * (g + 0.08*w) for w, g in zip(self.weights, gradient)]

    def _vocabulary(self, field, limit, minimum):
        counts = Counter(v for row in self.rows for v in set(row.get(field, [])))
        return sorted(k for k, n in sorted(counts.items(), key=lambda p: (-p[1], p[0]))[:limit] if n >= minimum)

    def features(self, row, exclude=None):
        result = {}
        assertions = self.content.get(row["id"], {}).get("assertions", {})
        for name in DIMENSIONS:
            assertion = assertions.get(name)
            result["content:" + name] = assertion["value"] if assertion else None
        for tag in self.tags:
            result["tag:" + tag] = 0.4 if tag in row.get("tags", []) else 0.0
        for author in self.authors:
            result["author:" + author] = 0.25 if author in row.get("authors", []) else 0.0
        for modality in ("cover", "title", "joint"):
            query = self.vectors.get(row["id"], {}).get(modality)
            if not query or self.mode != "combined":
                result["vector:" + modality] = None
                continue
            groups = []
            for label in (0, 1):
                total, count = self.prototypes.get((modality, len(query), label), ([], 0))
                if exclude in self.ratings and int(self.ratings[exclude] >= 7) == label and total:
                    own = self.vectors.get(exclude, {}).get(modality)
                    if own and len(own) == len(total):
                        total, count = [a-b for a, b in zip(total, own)], count-1
                groups.append(cosine(query, total) if count else None)
            result["vector:" + modality] = (
                (groups[1] - groups[0]) * 0.5
                if all(g is not None for g in groups) else None
            )
        return result

    def center(self, features):
        return [features[name] - self.means[name] if features.get(name) is not None else 0.0
                for name in self.names]

    def predict(self, row):
        raw = self.features(row, exclude=row["id"])
        contributions = dict(zip(self.names, (x*w for x, w in zip(self.center(raw), self.weights))))
        score = 100 * sigmoid(self.bias + sum(contributions.values()))
        # Evidence coverage is deliberately not labelled probability/confidence.
        known = sum(raw.get("content:" + name) is not None for name in DIMENSIONS)
        return score, contributions, known


def feedback_adjustment(candidate, rows, vectors):
    """Explicit dimension feedback only; passive events never enter training."""
    totals = {}
    for row in rows:
        for reason, state in row.get("interest_feedback", {}).items():
            # An explicit total rating supersedes an earlier overall impression.
            if reason == "overall" and row.get("rating") is not None:
                continue
            if reason in ("tag_mix", "author", "overall"):
                field = "authors" if reason == "author" else "tags"
                a, b = set(candidate.get(field, [])), set(row.get(field, []))
                similarity = len(a & b) / len(a | b) if a | b else 0
            else:
                similarity = cosine(vectors.get(candidate["id"], {}).get(reason),
                                    vectors.get(row["id"], {}).get(reason))
                similarity = max(0, similarity or 0)
            if similarity:
                totals.setdefault(reason, []).append(similarity * (1 if state["value"] else -1))
    # Bounded auxiliary adjustment: several dimensions cannot swamp ratings.
    return max(-5, min(5, sum(sum(v)/(len(v)+2) * 3 for v in totals.values())))
