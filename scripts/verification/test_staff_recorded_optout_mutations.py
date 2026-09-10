import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("mutations", Path(__file__).with_name("staff-recorded-optout-mutations.py"))
mutations = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mutations)


class MutationLogTests(unittest.TestCase):
    def test_logs_are_exclusive_private_and_preserve_existing_symlink_targets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "do-not-overwrite"
            target.write_text("original")
            for phase in ("red", "green"):
                (root / f"consent-B1-{phase}.log").symlink_to(target)
            original_open = open

            def sandbox_legacy_path(path, *args, **kwargs):
                path = Path(path)
                if path.parent == Path("/tmp"):
                    path = root / path.name
                return original_open(path, *args, **kwargs)

            names = []
            with patch.object(tempfile, "tempdir", directory), patch("builtins.open", sandbox_legacy_path):
                for phase in ("red", "green"):
                    for _ in range(2):
                        with mutations.mutation_log("B1", phase) as log:
                            log.write("evidence")
                            names.append(Path(log.name))
                        self.assertEqual(target.read_text(), "original")
                        self.assertEqual(names[-1].read_text(), "evidence")
                        self.assertEqual(names[-1].stat().st_mode & 0o777, 0o600)
            self.assertEqual(len(set(names)), 4)


if __name__ == "__main__":
    unittest.main()
