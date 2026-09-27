import tempfile
import unittest
from pathlib import Path
from local_features import LocalFeatureStore, LocalFeatureError

class HistoryStorageTests(unittest.TestCase):
    def test_merge_restart_clear_and_import_receipts(self):
        with tempfile.TemporaryDirectory() as directory:
            store = LocalFeatureStore(Path(directory))
            old = {"id": "1", "name": "old", "savedAt": 10}
            new = {"id": "1", "name": "new", "savedAt": 20}
            store.library_history("reading", [new])
            store.library_history("reading", [old], legacy=True)
            store.library_history("random", [old], legacy=True)
            store = LocalFeatureStore(Path(directory))
            self.assertEqual(store.library_history("reading")["items"], [new])
            store.library_history("reading", clear=True)
            self.assertEqual(store.library_history("reading", [old], legacy=True)["items"], [])
            self.assertEqual(store.library_history("random")["items"], [old])
            self.assertEqual(store.library_history("reading", [new])["items"], [new])

    def test_invalid_batch_is_atomic_and_lists_are_sorted(self):
        with tempfile.TemporaryDirectory() as directory:
            store = LocalFeatureStore(Path(directory))
            with self.assertRaises(LocalFeatureError):
                store.library_history("reading", [{"id": "1", "savedAt": 1}, {"id": "bad"}])
            self.assertEqual(store.library_history("reading")["items"], [])
            for kind in ["bad", None]:
                with self.assertRaises(LocalFeatureError): store.library_history(kind)
            items = [{"id": str(i), "savedAt": i} for i in range(300)]
            self.assertEqual(len(store.library_history("random", items)["items"]), 300)
            self.assertEqual(store.library_history("random")["items"][0]["id"], "299")
