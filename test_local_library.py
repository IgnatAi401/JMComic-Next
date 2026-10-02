import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from local_library import LibraryError, LocalLibrary, atomic_json_write


class LibraryTestCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.library = LocalLibrary(self.directory)


class HistoryTests(LibraryTestCase):
    def test_merge_restart_clear_and_import_receipts(self):
        old = {"id": "1", "name": "old", "savedAt": 10}
        new = {"id": "1", "name": "new", "savedAt": 20}
        self.library.library_history("reading", [new])
        self.library.library_history("reading", [old], legacy=True)
        self.library.library_history("random", [old], legacy=True)
        library = LocalLibrary(self.directory)
        self.assertEqual(library.library_history("reading")["items"], [new])
        library.library_history("reading", clear=True)
        self.assertEqual(library.library_history("reading", [old], legacy=True)["items"], [])
        self.assertEqual(library.library_history("random")["items"], [old])
        self.assertEqual(library.library_history("reading", [new])["items"], [new])

    def test_invalid_batch_is_atomic_and_lists_are_sorted(self):
        with self.assertRaises(LibraryError):
            self.library.library_history("reading", [{"id": "1", "savedAt": 1}, {"id": "bad"}])
        self.assertEqual(self.library.library_history("reading")["items"], [])
        for kind in ["bad", None]:
            with self.assertRaises(LibraryError):
                self.library.library_history(kind)
        items = [{"id": str(i), "savedAt": i} for i in range(300)]
        self.assertEqual(len(self.library.library_history("random", items)["items"]), 300)
        self.assertEqual(self.library.library_history("random")["items"][0]["id"], "299")

    def test_watch_later_removes_single_entries(self):
        self.library.library_history("later", [{"id": "1", "savedAt": 1}, {"id": "2", "savedAt": 2}])
        self.library.library_history("reading", [{"id": "1", "savedAt": 1}])
        self.assertEqual([item["id"] for item in self.library.library_history("later", remove="1")["items"]], ["2"])
        self.assertEqual(len(self.library.library_history("reading")["items"]), 1)
        with self.assertRaises(LibraryError):
            self.library.library_history("later", remove="bad")


class SearchHistoryTests(LibraryTestCase):
    def test_recent_first_deduplicated_bounded_and_removable(self):
        for query in ["甲", "乙", "甲"]:
            items = self.library.search_history(query)["items"]
        self.assertEqual([item["query"] for item in items], ["甲", "乙"])
        for index in range(60):
            self.library.search_history(f"关键词{index}")
        items = self.library.search_history()["items"]
        self.assertEqual(len(items), 50)
        self.assertEqual(items[0]["query"], "关键词59")
        self.assertNotIn("关键词49", [item["query"] for item in self.library.search_history(remove="关键词49")["items"]])
        for bad in ["", "  ", "x" * 81]:
            with self.assertRaises(LibraryError):
                self.library.search_history(bad)
        self.assertEqual(self.library.search_history(clear=True)["items"], [])


class RatingTests(LibraryTestCase):
    def test_rating_round_trip_update_and_clear(self):
        comic = {"id": "42", "title": "示例", "authors": ["甲", "甲", "乙"], "cover_url": "/c.jpg", "rating": 7}
        saved = self.library.save_rating(comic)
        self.assertEqual(saved | {"updated_at": 0}, {
            "id": "42", "title": "示例", "authors": ["甲", "乙"], "cover_url": "/c.jpg", "rating": 7, "updated_at": 0,
        })
        self.assertEqual(self.library.save_rating({**comic, "rating": 9})["rating"], 9)
        self.assertEqual([item["rating"] for item in self.library.list_ratings()], [9])
        self.assertIsNone(self.library.save_rating({"id": "42", "rating": None}))
        self.assertIsNone(self.library.get_rating("42"))
        self.assertEqual(self.library.list_ratings(), [])

    def test_invalid_ratings_are_rejected_without_writing(self):
        for value in (0, 11, 7.5, "7", True):
            with self.subTest(rating=value), self.assertRaisesRegex(LibraryError, "1 到 10"):
                self.library.save_rating({"id": "1", "rating": value})
        for comic_id in ("", "abc", "1" * 17, None):
            with self.subTest(comic_id=comic_id), self.assertRaisesRegex(LibraryError, "漫画 ID"):
                self.library.save_rating({"id": comic_id, "rating": 5})
        self.assertEqual(self.library.list_ratings(), [])


class PreferenceTests(LibraryTestCase):
    def test_tag_and_author_levels_upsert_rename_and_delete(self):
        self.library.set_preference({"kind": "tag", "name": " 旅行 ", "level": "like"})
        self.library.set_preference({"kind": "tag", "name": "日常", "level": "fond"})
        self.library.set_preference({"kind": "tag", "name": "恐怖", "level": "avoid"})
        self.library.set_preference({"kind": "tag", "name": "猎奇", "level": "dislike"})
        result = self.library.set_preference({"kind": "author", "name": "示例作者", "level": "dislike"})
        self.assertEqual(result, {
            "tags": {"旅行": "like", "日常": "fond", "恐怖": "avoid", "猎奇": "dislike"},
            "authors": {"示例作者": "dislike"},
        })
        result = self.library.set_preference({"kind": "tag", "name": "日常", "level": "like"})
        self.assertEqual(result["tags"]["日常"], "like")
        result = self.library.set_preference({"kind": "tag", "name": "旅途", "level": "fond", "previous": "旅行"})
        self.assertNotIn("旅行", result["tags"])
        self.assertEqual(result["tags"]["旅途"], "fond")
        result = self.library.set_preference({"kind": "author", "name": "示例作者", "level": None})
        self.assertEqual(result["authors"], {})
        self.assertEqual(LocalLibrary(self.directory).preferences()["tags"]["猎奇"], "dislike")

    def test_invalid_preferences_are_rejected(self):
        cases = [
            ({"kind": "work", "name": "x", "level": "like"}, "类型"),
            ({"kind": "tag", "name": "  ", "level": "like"}, "名称"),
            ({"kind": "tag", "name": "x" * 81, "level": "like"}, "名称"),
            ({"kind": "tag", "name": "a\nb", "level": "like"}, "名称"),
            ({"kind": "tag", "name": "x", "level": "block"}, "等级"),
            ({"kind": "author", "name": "x", "level": "fond"}, "等级"),
            ({"kind": "author", "name": "x", "level": "avoid"}, "等级"),
        ]
        for value, message in cases:
            with self.subTest(value=value), self.assertRaisesRegex(LibraryError, message):
                self.library.set_preference(value)
        self.assertEqual(self.library.preferences(), {"tags": {}, "authors": {}})

    def test_limit_applies_to_new_names_and_a_failed_rename_rolls_back(self):
        self.library.set_preference({"kind": "tag", "name": "旅行", "level": "like"})
        with patch("local_library.MAX_PREFERENCES_PER_KIND", 1):
            with self.assertRaisesRegex(LibraryError, "最多"):
                self.library.set_preference({"kind": "tag", "name": "新标签", "level": "like"})
            self.library.set_preference({"kind": "tag", "name": "旅行", "level": "fond"})
            self.library.set_preference({"kind": "author", "name": "作者", "level": "like"})
        with patch("local_library.MAX_PREFERENCES_PER_KIND", 0), self.assertRaisesRegex(LibraryError, "最多"):
            self.library.set_preference({"kind": "tag", "name": "旅途", "level": "like", "previous": "旅行"})
        self.assertEqual(self.library.preferences(), {"tags": {"旅行": "fond"}, "authors": {"作者": "like"}})


class StorageTests(LibraryTestCase):
    def test_connection_is_closed_after_operation_and_after_error(self):
        connection = self.library.connect()
        with patch.object(self.library, "connect", return_value=connection):
            self.library.list_ratings()
        with self.assertRaises(sqlite3.ProgrammingError):
            connection.execute("SELECT 1")
        connection = self.library.connect()
        with patch.object(self.library, "connect", return_value=connection), \
                patch("local_library.MAX_PREFERENCES_PER_KIND", 0), self.assertRaises(LibraryError):
            self.library.set_preference({"kind": "tag", "name": "x", "level": "like", "previous": "y"})
        with self.assertRaises(sqlite3.ProgrammingError):
            connection.execute("SELECT 1")

    def test_atomic_json_write_removes_temporary_file_after_replace_failure(self):
        target = self.directory / "atomic.json"
        with patch("local_library.os.replace", side_effect=OSError("replace failed")), self.assertRaises(OSError):
            atomic_json_write(target, {"ok": True})
        self.assertFalse(target.exists())
        self.assertEqual(list(target.parent.glob("atomic.json.*.tmp")), [])

    def test_atomic_json_write_fsyncs_file_and_parent_directory(self):
        target = self.directory / "durable.json"
        with (
            patch("local_library.os.open", return_value=123) as mocked_open,
            patch("local_library.os.fsync") as mocked_fsync,
            patch("local_library.os.close") as mocked_close,
        ):
            atomic_json_write(target, {"ok": True})
        mocked_open.assert_called_once_with(target.parent, os.O_RDONLY)
        self.assertEqual(mocked_fsync.call_count, 2)
        mocked_fsync.assert_any_call(123)
        mocked_close.assert_called_once_with(123)


if __name__ == "__main__":
    unittest.main()
