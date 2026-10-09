import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class StableReleaseWorkflowTest(unittest.TestCase):
    def test_new_releases_are_published_as_latest_stable_releases(self):
        workflow = (ROOT / ".github/workflows/release.yml").read_text()
        publish = workflow.split("gh release create", 1)[1]
        self.assertNotIn("--prerelease", publish)
        self.assertIn("--latest", publish)
        self.assertIn("Linux release", publish)

    def test_existing_exact_release_is_repaired_to_stable_latest(self):
        workflow = (ROOT / ".github/workflows/release.yml").read_text()
        existing = workflow.split("if gh release view", 1)[1].split("fi", 1)[0]
        self.assertIn("prerelease=false", existing)
        self.assertIn("make_latest=true", existing)
        self.assertIn("gh api --method PATCH", existing)

    def test_release_workflow_and_notes_do_not_call_stable_releases_prereleases(self):
        workflow = (ROOT / ".github/workflows/release.yml").read_text()
        self.assertNotIn("name: Linux preview release", workflow)
        self.assertNotIn("preview", workflow.lower())
        self.assertTrue((ROOT / "docs/linux-release.md").is_file())
