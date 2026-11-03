import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "check-staged-paths.py"


class CheckStagedPathsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="git-ignore-hook-test-")
        self.repo = Path(self.temp.name)
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        self.env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
        subprocess.run(["git", "init", "-q", str(self.repo)], env=self.env, check=True)
        (self.repo / "scripts").mkdir()
        shutil.copy2(SCRIPT, self.repo / "scripts/check-staged-paths.py")

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.repo, env=self.env, check=True, capture_output=True)

    def check(self):
        return subprocess.run(["python3", "scripts/check-staged-paths.py"], cwd=self.repo,
                              env=self.env, capture_output=True, text=True)

    def test_normal_staged_file_is_allowed(self):
        (self.repo / "notes.txt").write_text("ordinary content\n")
        self.git("add", "notes.txt")
        self.assertEqual(self.check().returncode, 0)

    def test_force_staged_ignored_file_outside_pi_is_rejected(self):
        (self.repo / ".gitignore").write_text("private/\n")
        (self.repo / "private").mkdir()
        (self.repo / "private/data.txt").write_text("synthetic data\n")
        self.git("add", "-f", "private/data.txt")
        result = self.check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("private/data.txt", result.stderr)

    def test_force_staged_ignored_pi_auth_is_rejected(self):
        (self.repo / ".gitignore").write_text("/.pi/agent/auth.json\n")
        (self.repo / ".pi/agent").mkdir(parents=True)
        (self.repo / ".pi/agent/auth.json").write_text("synthetic credential\n")
        self.git("add", "-f", ".pi/agent/auth.json")
        self.assertNotEqual(self.check().returncode, 0)

    def test_previously_tracked_file_matching_ignore_is_rejected(self):
        tracked = self.repo / "tracked.tmp"
        tracked.write_text("before\n")
        self.git("add", "tracked.tmp")
        self.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "baseline")
        (self.repo / ".gitignore").write_text("*.tmp\n")
        tracked.write_text("after\n")
        self.git("add", "tracked.tmp")
        self.assertNotEqual(self.check().returncode, 0)

    def test_newline_in_filename_is_checked_without_splitting(self):
        (self.repo / ".gitignore").write_text("ignored*/\n")
        (self.repo / "ignored-dir").mkdir()
        path = self.repo / "ignored-dir/line\nbreak.txt"
        path.write_text("synthetic data\n")
        self.git("add", "-f", str(path.relative_to(self.repo)))
        self.assertNotEqual(self.check().returncode, 0)


if __name__ == "__main__":
    unittest.main()
