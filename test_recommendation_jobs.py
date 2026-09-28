import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from recommendation_jobs import RecommendationJobs


class RecommendationJobTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = SimpleNamespace(data_dir=Path(self.temp.name),
                                     generate_recommendations=Mock(return_value={"id": 9, "recommendations": []}))
        self.jobs = RecommendationJobs(self.store)
        self.value = {"id": "task-1234567890123456", "payload": {"candidates": [{"id": "1", "title": "test"}], "budget": 2}}
        self.evidence = patch('recommendation_jobs.ContentEvidence').start()
        self.evidence.return_value.plan.return_value = {"configured": True, "training": [{"id": "2"}], "candidates": [{"id": "1"}]}
        self.evidence.return_value.prepare.return_value = {"status": "ready"}

    def tearDown(self):
        deadline = time.monotonic() + 3
        while self.jobs.workers and time.monotonic() < deadline:
            time.sleep(.01)
        patch.stopall()
        self.temp.cleanup()

    def wait(self, status):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            job = self.jobs.get(self.value['id'])
            if job and job['status'] == status:
                return job
            time.sleep(.01)
        self.fail(f"did not reach {status}: {job}")

    def test_lost_ack_and_duplicate_upload_produce_one_run(self):
        self.jobs.submit(self.value)
        self.wait('awaiting_comments')
        # Repeated submissions represent a lost HTTP acknowledgement.
        for _ in range(3):
            self.assertTrue(self.jobs.submit(self.value)['accepted'])
        self.jobs.upload(self.value['id'], {'id': '2', 'comments': [{'content': 'test'}]})
        self.jobs.upload(self.value['id'], {'id': '2', 'comments': []})
        self.jobs.upload(self.value['id'], {'id': '1', 'comments': []})
        job = self.wait('success')
        self.assertEqual(job['finished'], 2)
        self.assertEqual(job['result']['id'], 9)
        self.jobs.upload(self.value['id'], {'id': '1', 'comments': []})
        self.store.generate_recommendations.assert_called_once()
        self.assertEqual(self.evidence.return_value.prepare.call_count, 2)
        self.assertNotIn('payload', job)
        self.assertNotIn('sources', job)

    def test_conflicting_id_cannot_replace_accepted_payload(self):
        self.jobs.submit(self.value)
        with self.assertRaises(ValueError):
            self.jobs.submit(dict(self.value, payload={"candidates": [{"id": "3"}], "budget": 0}))
        self.assertEqual(self.jobs.read(self.value['id'])['payload'], self.value['payload'])

    def test_restart_retains_awaiting_sources_and_marks_running_interrupted(self):
        self.jobs.submit(self.value)
        self.wait('awaiting_comments')
        self.jobs.upload(self.value['id'], {'id': '2', 'comments': []})
        restarted = RecommendationJobs(self.store)
        recovered = restarted.get(self.value['id'])
        self.assertEqual(recovered['status'], 'awaiting_comments')
        self.assertEqual(recovered['received_ids'], ['2'])
        with restarted.lock:
            job = restarted.read(self.value['id'])
            job['status'] = 'running'
            restarted.save(job)
        self.assertEqual(RecommendationJobs(self.store).get(self.value['id'])['status'], 'interrupted')
        self.store.generate_recommendations.assert_not_called()

    def test_cancel_during_analysis_finishes_inflight_without_ranking(self):
        entered, release = threading.Event(), threading.Event()
        def prepare(_):
            entered.set()
            release.wait(2)
            return {'status': 'ready'}
        self.evidence.return_value.prepare.side_effect = prepare
        self.jobs.submit(self.value)
        self.wait('awaiting_comments')
        for key in ['2', '1']:
            self.jobs.upload(self.value['id'], {'id': key, 'comments': []})
        self.assertTrue(entered.wait(2))
        for _ in range(3):
            self.assertEqual(self.jobs.cancel(self.value['id'])['status'], 'cancelling')
        release.set()
        self.wait('cancelled')
        self.store.generate_recommendations.assert_not_called()

    def test_zero_budget_runs_without_browser_upload(self):
        self.value['payload']['budget'] = 0
        self.jobs.submit(self.value)
        self.wait('success')
        self.evidence.return_value.prepare.assert_not_called()
        self.store.generate_recommendations.assert_called_once()

    def test_commit_failure_does_not_acknowledge_or_launch(self):
        with patch.object(self.jobs, 'save', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                self.jobs.submit(self.value)
        self.assertFalse(self.jobs.workers)
        self.assertIsNone(self.jobs.get(self.value['id']))

    def test_analysis_failure_is_visible_but_sorting_uses_available_evidence(self):
        self.evidence.return_value.prepare.side_effect = RuntimeError('provider failed')
        self.jobs.submit(self.value)
        self.wait('awaiting_comments')
        for key in ['2', '1']:
            self.jobs.upload(self.value['id'], {'id': key, 'comments': []})
        job = self.wait('success')
        self.assertEqual(job['failed'], 2)
        self.assertEqual(job['prepared'], 0)
