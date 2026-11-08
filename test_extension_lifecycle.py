"""Local checks for App Grid Only's JavaScript extension and metadata.

These checks do not launch GNOME Shell or contact desktop services. They catch
source syntax, extension packaging metadata, logging, and override-group drift.
"""

import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
EXTENSION_FILE = ROOT / "extension.js"
METADATA_FILE = ROOT / "metadata.json"
EXPECTED_UUID = "app-grid-only@fkj94"
EXPECTED_OVERRIDE_GROUPS = {
    "overview-entry",
    "workspace-layout",
    "show-apps-button",
    "state-navigation",
    "search-visibility",
    "native-gestures",
    "escape-key",
    "workspace-visibility",
}


class ExtensionSourceChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = EXTENSION_FILE.read_text(encoding="utf-8")
        cls.metadata = json.loads(METADATA_FILE.read_text(encoding="utf-8"))

    def test_metadata_matches_extension(self):
        self.assertEqual(self.metadata.get("uuid"), EXPECTED_UUID)
        self.assertTrue(self.metadata.get("name"))
        self.assertTrue(self.metadata.get("shell-version"))
        self.assertIsInstance(self.metadata.get("version"), int)
        self.assertIn("export default class", self.source)

    def test_javascript_syntax(self):
        node = shutil.which("node")
        if node is None:
            self.skipTest("Node.js is unavailable; JavaScript syntax was not checked")

        result = subprocess.run(
            [node, "--check", str(EXTENSION_FILE)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_override_groups_are_independent_and_logged(self):
        groups = set(re.findall(r"installGroup\('([^']+)'", self.source))
        self.assertEqual(groups, EXPECTED_OVERRIDE_GROUPS)
        self.assertIn("override-group-start", self.source)
        self.assertIn("override-group-ready", self.source)
        self.assertIn("installing override group ${name}", self.source)
        self.assertIn("this._injectionManager.overrideMethod(", self.source)
        self.assertIn("GNOME hook ${methodName}", self.source)

    def test_structured_error_logs_include_debug_context(self):
        self.assertIn("timestamp: new Date().toISOString()", self.source)
        self.assertIn("            level,", self.source)
        self.assertIn("            event,", self.source)
        self.assertIn("sequence: ++this._logSequence", self.source)
        self.assertIn("stack: error?.stack ?? null", self.source)
        self.assertIn("repeated-errors-suppressed", self.source)

    def test_required_gnome_hooks_are_validated(self):
        hooks = (
            "_computeWorkspacesBoxForState",
            "_getAppDisplayBoxForState",
            "_onShowAppsButtonToggled",
            "_onSearchChanged",
            "_shiftState",
            "gestureBegin",
            "gestureEnd",
            "_onStageKeyPress",
            "prepareToEnterOverview",
        )
        for hook in hooks:
            with self.subTest(hook=hook):
                self.assertIn(f"'{hook}'", self.source)


if __name__ == "__main__":
    unittest.main(verbosity=2)
