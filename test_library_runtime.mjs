import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./project/src/pages/library.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "")
    .replace(/new LibraryPage\(\)\.init\(\)\.catch\([^\n]+\);/, "");
const LibraryPage = vm.runInNewContext(`${source}\nLibraryPage;`);

test("rating filters include every matching comic and separate feedback without scores", () => {
    const page = new LibraryPage();
    page.localRatings = [
        ...Array.from({ length: 5001 }, (_, id) => ({ id, rating: 10 })),
        { id: "low", rating: 1 },
        { id: "review", rating: null, review: "评语" },
        { id: "tags", tag_feedback: { test: 1 } },
    ];
    assert.equal(page.filteredRatings().length, 5004);
    page.ratingFilter = "10";
    assert.equal(page.filteredRatings().length, 5001);
    page.ratingFilter = "1";
    assert.equal(page.filteredRatings()[0].id, "low");
    page.ratingFilter = "5";
    assert.equal(page.filteredRatings().length, 0);
    page.ratingFilter = "unrated";
    assert.equal(page.filteredRatings().length, 2);
    page.ratingFilters = { innerHTML: "" };
    page.renderRatingFilters();
    assert.match(page.ratingFilters.innerHTML, /10 分<span>5001<\/span>/);
    assert.match(page.ratingFilters.innerHTML, /data-rating="unrated" class="active" aria-pressed="true"/);
});
