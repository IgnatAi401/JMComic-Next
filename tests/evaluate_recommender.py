"""Read-only grouped evaluation; never imports/initializes the real store.

uv run --locked python tests/evaluate_recommender.py --database PATH --output PATH
Optional --baseline-module points to an archived old local_features.py for a
one-off comparison. It is loaded only against disposable training databases.
"""
from __future__ import annotations
import argparse
from contextlib import closing
import importlib.util
import json
import math
from pathlib import Path
import random
import re
import sqlite3
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from recommender import PreferenceModel


def load_database(path):
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        db.row_factory = sqlite3.Row
        rows = [dict(r) for r in db.execute("SELECT * FROM comics WHERE rating IS NOT NULL")]
        for row in rows:
            row["authors"], row["tags"] = json.loads(row["authors"]), json.loads(row["tags"])
        vectors = {}
        for r in db.execute("SELECT comic_id,modality,vector_json FROM item_feature_cache WHERE status='ready' AND vector_json IS NOT NULL"):
            vectors.setdefault(r["comic_id"], {})[r["modality"]] = json.loads(r["vector_json"])
        content = {}
        if db.execute("SELECT 1 FROM sqlite_master WHERE name='content_evidence'").fetchone():
            for r in db.execute("SELECT * FROM content_evidence WHERE status='ready'"):
                content[r["comic_id"]] = {"assertions": json.loads(r["assertions_json"])}
    return rows, content, vectors


def groups(rows, by_author):
    parent = {r["id"]: r["id"] for r in rows}
    def root(k):
        while parent[k] != k:
            parent[k] = parent[parent[k]]
            k = parent[k]
        return k
    seen = {}
    for row in rows:
        # Conservative title grouping: versions and numbered installments.
        title = re.sub(r"[\[【（(].*?[\]】）)]", "", row["title"])
        title = re.sub(r"[\W\d_]+", "", title).casefold()
        keys = (["title:"+title] if title else []) + (["author:"+a for a in row["authors"]] if by_author else [])
        for key in keys:
            if key in seen:
                parent[root(row["id"])] = root(seen[key])
            seen[key] = row["id"]
    grouped = {}
    for row in rows:
        grouped.setdefault(root(row["id"]), []).append(row)
    return list(grouped.values())


def folds_for(rows, by_author, seed):
    grouped = groups(rows, by_author)
    random.Random(seed).shuffle(grouped)
    grouped.sort(key=len, reverse=True)
    folds = [[] for _ in range(min(5, len(grouped)))]
    for group in grouped:
        # Balance fold sizes and class counts without splitting a group.
        positive = sum(r["rating"] >= 7 for r in group)
        target = min(folds, key=lambda f: len(f) +
                     (sum(r["rating"] >= 7 for r in f) if positive else sum(r["rating"] < 7 for r in f)))
        target.extend(group)
    return folds


def metrics(predictions):
    ordered = sorted(predictions, key=lambda r: (-r[1], r[0]["id"]))
    pos = [s for r, s in ordered if r["rating"] >= 7]
    mid = [s for r, s in ordered if r["rating"] == 6]
    neg = [s for r, s in ordered if r["rating"] < 7]
    def auc(a, b):
        return sum((x > y) + 0.5*(x == y) for x in a for y in b)/(len(a)*len(b)) if a and b else None
    result = {"auc_7_vs_6": auc(pos, mid), "auc_7_vs_rest": auc(pos, neg)}
    for k in (10, 20):
        top = ordered[:k]
        result[f"precision_at_{k}"] = sum(r["rating"] >= 7 for r, _ in top)/len(top) if top else None
    gain = lambda r: max(0, r["rating"]-6)
    dcg = sum(gain(r)/math.log2(i+2) for i, (r, _) in enumerate(ordered[:20]))
    ideal = sorted((r for r, _ in ordered), key=gain, reverse=True)[:20]
    idcg = sum(gain(r)/math.log2(i+2) for i, r in enumerate(ideal))
    result["ndcg_at_20"] = dcg/idcg if idcg else None
    return result


def old_scores(module, train, test, vectors):
    with tempfile.TemporaryDirectory() as directory:
        store = module.LocalFeatureStore(Path(directory))
        for row in train:
            store.upsert_comic(row)
            if row["id"] in vectors:
                store.save_item_features({"comic_id": row["id"], "features": {
                    m: {"status": "ready", "vector": v} for m, v in vectors[row["id"]].items()}})
        model = store._build_preference_model()
        return [(row, store._score_candidate_structured(model, {
            **row, "_feature_inputs": vectors.get(row["id"], {})}, {})["score"]) for row in test]


def evaluate(rows, content, vectors, baseline=None):
    report = {"samples": len(rows), "liked": sum(r["rating"] >= 7 for r in rows),
              "six": sum(r["rating"] == 6 for r in rows), "content_samples": len(set(content) & {r["id"] for r in rows}),
              "limitations": ["Retrospective grouped validation, not prospective recommendation accuracy.",
                               "All preprocessing is fitted on training folds. Existing feature definitions were explored on historical data.",
                               "Old baseline comparison isolates rating/metadata signals, not historical passive events.",
                               "Precision@K is averaged within held-out folds, not a platform-wide hit rate."], "results": {}}
    for split, authors in (("work_grouped", False), ("author_grouped", True)):
        for mode in ["metadata", "content", "combined"] + (["old_baseline"] if baseline else []):
            measurements = []
            for seed in (7, 19, 43):
                folds = folds_for(rows, authors, seed)
                for index, test in enumerate(folds):
                    train = [r for i, fold in enumerate(folds) if i != index for r in fold]
                    if not test or len({r["rating"] >= 7 for r in train}) < 2:
                        continue
                    if mode == "old_baseline":
                        predictions = old_scores(baseline, train, test, vectors)
                    else:
                        model = PreferenceModel(train, content, vectors, mode=mode)
                        predictions = [(r, model.predict(r)[0]) for r in test]
                    measurements.append(metrics(predictions))
            keys = metrics([]).keys()
            summary = {}
            for key in keys:
                values = [m[key] for m in measurements if m[key] is not None]
                mean = sum(values)/len(values) if values else None
                summary[key] = {"mean": round(mean, 4) if mean is not None else None,
                                "min": round(min(values), 4) if values else None,
                                "max": round(max(values), 4) if values else None}
            report["results"][split+":"+mode] = {"folds": len(measurements), **summary}
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--baseline-module", type=Path)
    args = parser.parse_args()
    baseline = None
    if args.baseline_module:
        spec = importlib.util.spec_from_file_location("old_recommender_evaluation", args.baseline_module)
        baseline = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(baseline)
    report = evaluate(*load_database(args.database), baseline=baseline)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({k: report[k] for k in ("samples", "liked", "six", "content_samples")}, ensure_ascii=False))
    print(f"Report: {args.output}")
