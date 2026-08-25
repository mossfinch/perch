"""Pin the false-green guards of the internal export script export-perch.py,
without running a full extraction.

The tests load the real export module and build files only in temporary
directories.
They modify neither the working repo nor the public one.
The focus is the false green from a python suite that discovered nothing.
It also pins the false green from a privacy scan that reads every file and
recognises no leak.

Every address and home-path sample is assembled in pieces.
That keeps this test's own source free of the complete shapes the privacy scan
must refuse."""
import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
# The working repo keeps the package under apps/mac-widget/; after extraction
# that directory IS the repo root.
# The layout is probed by the Perch directory, so a fixed number of levels up
# cannot break in the other layout.
PKG = ROOT / "apps" / "mac-widget" if (ROOT / "apps" / "mac-widget" / "Perch").is_dir() else ROOT
MODULE_PATH = PKG / "export-perch.py"


def load_module():
    """Load export-perch.py from the current layout, without running main()."""
    spec = importlib.util.spec_from_file_location("export_perch", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RanCountTest(unittest.TestCase):
    """Pins that a unittest discovery finding nothing still exits 0.
    And that the counter tells zero discovery, a real count and no summary
    apart."""

    def setUp(self):
        self.ep = load_module()

    def test_the_vacuous_pass_is_real_and_is_detected(self):
        # Runs the real unittest discover, and pins both halves at once: finding
        # nothing exits 0 and reports zero tests.
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "tests").mkdir()
            r = subprocess.run([sys.executable, "-B", "-m", "unittest", "discover",
                                "-s", "tests", "-p", "no_such_file_test.py"],
                               cwd=tmp, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0,
                         "control: this test exists because discovery-finds-nothing exits 0")
        self.assertIn("OK", r.stderr, "control: it also prints OK")
        # The counter must recognise zero discovery, or the gate waves through a
        # suite that executed no test at all.
        self.assertEqual(self.ep.ran_count(r.stderr), 0,
                         "the count parser cannot see a zero-test run, so the gate would wave it through")

    def test_a_real_run_is_counted(self):
        # Control group: the parser must return a true count, or "always 0"
        # would be a false green.
        with tempfile.TemporaryDirectory() as tmp:
            tests = Path(tmp) / "tests"
            tests.mkdir()
            (tests / "sample_test.py").write_text(
                "import unittest\n"
                "class T(unittest.TestCase):\n"
                "    def test_a(self): pass\n"
                "    def test_b(self): pass\n"
                "    def test_c(self): pass\n")
            r = subprocess.run([sys.executable, "-B", "-m", "unittest", "discover",
                                "-s", "tests", "-p", "*_test.py"],
                               cwd=tmp, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0)
        self.assertEqual(self.ep.ran_count(r.stderr), 3)

    def test_no_summary_line_is_not_reported_as_zero(self):
        # No summary and zero discovery are two different failures; -1 keeps
        # them apart in the message a human reads.
        self.assertEqual(self.ep.ran_count("Traceback (most recent call last):\n"), -1)
        self.assertEqual(self.ep.ran_count(""), -1)

    def test_the_singular_is_parsed_too(self):
        # unittest's singular summary is "Ran 1 test"; a pattern demanding the
        # plural blocks a valid release.
        self.assertEqual(self.ep.ran_count("Ran 1 test in 0.001s\n\nOK\n"), 1)

    def test_the_gate_refuses_a_suite_that_ran_nothing(self):
        # Parsing the count is not enough; main() must discover by pattern and
        # refuse a count below 1.
        src = MODULE_PATH.read_text()
        self.assertIn('"-p", "*_test.py"', src,
                      "the gate discovers by a hardcoded filename again — a second test file would be skipped")
        self.assertIn("ran = ran_count(", src, "the gate does not count what it ran")
        self.assertIn("if ran < 1:", src, "the gate counts and then does not act on the count")


class PrivateHitTest(unittest.TestCase):
    """Pins that the matcher accepts clean bytes.
    And that it refuses the local identity, a general macOS home path and an
    address."""

    def setUp(self):
        self.ep = load_module()
        self.terms = ["someuser", "/Users" + "/someuser"]

    def test_clean_text_is_clean(self):
        # Control group: clean bytes must pass, or every other refusal assertion
        # here could be green for a matcher that flags everything.
        self.assertIsNone(self.ep.private_hit(b"struct IslandCardShape: Shape {}", self.terms))
        self.assertIsNone(self.ep.private_hit(b"io.github.mossfinch.perch.event-log", self.terms))

    def test_the_local_identity_is_caught(self):
        self.assertIsNotNone(self.ep.private_hit(b"/Users" + b"/someuser/Developer/x", self.terms))
        self.assertIsNotNone(self.ep.private_hit(b"logged in as someuser today", self.terms))

    def test_an_assigned_team_id_is_caught(self):
        # A Team ID names the person who registered it. This is the shape that
        # arrives without anyone typing it: Xcode stamps it into the project the
        # moment automatic signing is switched on, and the export would
        # otherwise print "zero private-term hits" while shipping it.
        # Assembled, because the privacy guard scans this file too.
        key = b"DEVELOPMENT" + b"_TEAM"
        for probe in [key + b" = Z9Y8X7W6V5;",
                      key + b' = "Z9Y8X7W6V5";',
                      key + b"=Z9Y8X7W6V5"]:
            self.assertIsNotNone(self.ep.private_hit(probe, self.terms), probe)

    def test_team_id_shaped_text_that_is_not_an_assignment_is_left_alone(self):
        # Ten uppercase characters are far too common to refuse on sight, and
        # the island's own tests carry fake ones on purpose to prove a
        # team-prefixed group id is tolerated. Refusing these would make the
        # export impossible to run rather than safe.
        key = b"DEVELOPMENT" + b"_TEAM"
        for probe in [b'group_core("ABCDE12345.group.io.example.perch")',
                      b"AB12CD34EF.group.com.someoneelse.app/bridge.sock",
                      b"match(/" + key + rb"\s*=\s*(\S+)/)",
                      b'if line.startswith("' + key + b'"):']:
            self.assertIsNone(self.ep.private_hit(probe, self.terms), probe)

    def test_this_machines_team_id_becomes_a_term(self):
        # The value itself, not just the assignment shape: a copy of it can
        # reach a shipped file with no DEVELOPMENT_TEAM next to it.
        import tempfile, pathlib as _p
        with tempfile.TemporaryDirectory() as d:
            root = _p.Path(d)
            self.assertEqual(self.ep.local_team_ids(root), [],
                             "no config means no team to refuse, not a crash")
            (root / "Config.xcconfig").write_text(
                "// a comment mentioning DEVELOPMENT" + "_TEAM = NOTTHISONE\n"
                "PRODUCT_NAME = Perch\n"
                "DEVELOPMENT" + "_TEAM = Z9Y8X7W6V5\n")
            found = self.ep.local_team_ids(root)
            self.assertEqual(found, ["Z9Y8X7W6V5"], "a commented-out team is not this machine's")
            terms = self.terms + found
            self.assertIsNotNone(
                self.ep.private_hit(b"<string>Z9Y8X7W6V5.group.io.example.x</string>", terms),
                "the bare value must be refused once it is a term")

    def test_a_stranger_home_path_is_caught_too(self):
        # The exact term list covers this machine only; the general pattern must
        # recognise a macOS home path from another clone.
        self.assertIsNotNone(self.ep.private_hit(b"/Users" + b"/nobodyhere/x", self.terms))

    def test_an_address_is_caught_in_the_shapes_that_actually_occur(self):
        at = b"@"
        for probe in [b"a" + at + b"b.co", b"first.last" + at + b"example.com",
                      b"name+tag" + at + b"sub.example.co.uk",
                      b"12345+user" + at + b"users.noreply.github.com"]:
            with self.subTest(probe=probe):
                self.assertIsNotNone(self.ep.private_hit(probe, self.terms))

    def test_an_empty_term_does_not_match_everything(self):
        # An empty string hits every buffer; unskipped, the scan reports the
        # whole package as a leak.
        self.assertIsNone(self.ep.private_hit(b"perfectly fine", ["", "/Users" + "/someuser"]))



class ScanForLeaksTest(unittest.TestCase):
    """Drives the whole leak scan against real files on a temporary disk.
    Pins clean input, real hits and both control groups."""

    def setUp(self):
        self.ep = load_module()
        self.terms = ["someuser", "/Users" + "/someuser"]
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def plant(self, **files):
        """Write the named text fixtures and return their relative paths,
        sorted."""
        for name, text in files.items():
            (self.dir / name).write_text(text)
        return sorted(files)

    def test_a_clean_package_passes(self):
        # Control group: a clean package must pass, or every failure assertion
        # below could be green for a scan that refuses everything.
        landed = self.plant(a_swift="struct IslandCardShape: Shape {}")
        self.assertIsNone(self.ep.scan_for_leaks(self.dir, landed, self.terms))

    def test_a_planted_address_is_reported(self):
        landed = self.plant(a_swift="struct IslandCardShape: Shape {}",
                            b_md="written by " + "nobody" + "@" + "example.com")
        problem = self.ep.scan_for_leaks(self.dir, landed, self.terms)
        self.assertIsNotNone(problem, "a package carrying an address extracted clean")
        self.assertIn("b_md", problem, "the report does not say which file it is in")

    def test_a_planted_home_path_is_reported(self):
        landed = self.plant(a_swift="struct IslandCardShape: Shape {}",
                            b_txt="/Users" + "/someuser/Developer/thing")
        self.assertIsNotNone(self.ep.scan_for_leaks(self.dir, landed, self.terms))

    def test_reading_nothing_is_not_a_pass(self):
        # Control A: an empty landed list means the scan read no file at all,
        # and that may never be reported as clean.
        problem = self.ep.scan_for_leaks(self.dir, [], self.terms)
        self.assertIsNotNone(problem, "a scan that read no files at all reported success")
        self.assertIn("Control group failed", problem)

    def test_a_matcher_that_recognises_nothing_is_caught(self):
        # Control B pins that the matcher really refuses a sample.
        # Control A, which only proves the files were read, cannot see a dead
        # matcher.
        landed = self.plant(a_swift="struct IslandCardShape: Shape {}")
        blind = lambda buf, terms: None
        problem = self.ep.scan_for_leaks(self.dir, landed, self.terms, matcher=blind)
        self.assertIsNotNone(problem, "a matcher that detects nothing was trusted for its silence")
        self.assertIn("through", problem)

    def test_the_extractor_actually_calls_this(self):
        # This is a call-site text guard; all it can stop is the scan call or
        # its failure handling being deleted outright.
        # Proving the behaviour in full means running a whole extraction plus
        # the JavaScript suite, which is out of scope for a unit test.
        src = MODULE_PATH.read_text()
        self.assertIn("scan_for_leaks(target, landed, terms)", src,
                      "main() no longer runs the leak scan — the extraction has no privacy gate at all")
        self.assertIn("raise SystemExit(problem)", src,
                      "main() runs the scan and then does not act on what it says")

    def test_the_bite_control_covers_the_identity_branch_too(self):
        # One planted sample per matching branch; pinning only the general
        # patterns misses the exact local-identity branch.
        landed = self.plant(a_swift="struct IslandCardShape: Shape {}")
        patterns_only = lambda buf, terms: self.ep.private_hit(buf, [])
        problem = self.ep.scan_for_leaks(self.dir, landed, self.terms, matcher=patterns_only)
        self.assertIsNotNone(problem, "the identity branch is never proved to fire")


class StripNotesTest(unittest.TestCase):
    """Pins that whole-line agent notes come off.
    And that an inline survivor or a lowercase tag still stops the export."""

    # The tag is assembled so this test file does not itself carry the complete
    # shape the residue scan must refuse.
    TAG = "AIDEV"

    def setUp(self):
        self.ep = load_module()

    def note(self, comment):
        return comment + " " + self.TAG + "-NOTE: private aside"

    def test_whole_line_notes_go_and_code_stays(self):
        text = "\n".join(["let a = 1", "  " + self.note("//"),
                          "# ordinary comment", self.note("#"), "b = 2"])
        out, went = self.ep.strip_notes(text)
        self.assertEqual(went, 2)
        self.assertNotIn("private aside", out)
        for keep in ["let a = 1", "# ordinary comment", "b = 2"]:
            self.assertIn(keep, out, "the strip took a line that was not a note")

    def test_a_note_sharing_a_line_with_code_is_left_for_the_scan(self):
        # The tail of a code line may not be trimmed; the whole line survives
        # and the residue scan refuses the export.
        text = "let a = 1  " + self.note("//")
        out, went = self.ep.strip_notes(text)
        self.assertEqual((out, went), (text, 0))

    def test_a_lowercase_tag_is_stripped_and_a_lowercase_survivor_still_rings(self):
        # A difference in case is no licence to ship: a whole-line tag comes
        # off, an inline survivor is refused.
        out, went = self.ep.strip_notes("# " + self.TAG.lower() + "-note: psst\nkeep")
        self.assertEqual((went, out), (1, "keep"))
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            (d / "ok.swift").write_text("struct IslandCardShape: Shape {}")
            (d / "bad.swift").write_text("let a = 1  // " + self.TAG.lower() + "-note: rode along")
            problem = self.ep.scan_for_leaks(d, ["ok.swift", "bad.swift"],
                                             ["someuser", "/Users" + "/someuser"])
        self.assertIsNotNone(problem, "a lowercase survivor sailed through the residue scan")

    def test_the_other_tags_are_stripped_too(self):
        text = "# " + self.TAG + "-TODO: later\n// " + self.TAG + "-QUESTION: why\nkeep"
        out, went = self.ep.strip_notes(text)
        self.assertEqual((went, out), (2, "keep"))

    def test_an_unstripped_note_refuses_the_export(self):
        # Runs the residue scan directly, to pin that an unstripped inline note
        # stops the export.
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            (d / "ok.swift").write_text("struct IslandCardShape: Shape {}")
            (d / "bad.swift").write_text("let a = 1  // " + self.TAG + "-NOTE: rode along")
            problem = self.ep.scan_for_leaks(d, ["ok.swift", "bad.swift"],
                                             ["someuser", "/Users" + "/someuser"])
        self.assertIsNotNone(problem, "a surviving note sailed through the scan")
        self.assertIn("bad.swift", problem)

    def test_the_extractor_actually_strips(self):
        # This is a call-site text guard; all it can stop is the strip call
        # being deleted outright.
        src = MODULE_PATH.read_text()
        self.assertIn("strip_notes(text)", src,
                      "the copy loop no longer strips agent notes — they ship verbatim")


class GlobTest(unittest.TestCase):
    """Pins neverCopy's glob semantics, against wrong exclusions and missed
    nested private files."""

    def setUp(self):
        self.ep = load_module()

    def test_a_star_does_not_cross_a_slash(self):
        # A single star may not cross a slash, or one entry silently excludes a
        # whole subtree.
        r = self.ep.glob_to_re("apps/*.py")
        self.assertTrue(r.match("apps/a.py"))
        self.assertFalse(r.match("apps/sub/a.py"))

    def test_a_double_star_crosses_any_depth(self):
        r = self.ep.glob_to_re("**/.omc/**")
        for p in [".omc/x", "a/.omc/x", "a/b/c/.omc/d/e"]:
            with self.subTest(p=p):
                self.assertTrue(r.match(p), "a nested droppings directory is not blocked")

    def test_a_dot_is_a_dot(self):
        # A dot must match literally, or the entry drops files whose names
        # merely look alike.
        r = self.ep.glob_to_re("a.py")
        self.assertTrue(r.match("a.py"))
        self.assertFalse(r.match("axpy"))

    def test_the_manifest_globs_all_compile(self):
        import json
        man = json.loads((PKG / "perch-package.json").read_text())
        self.assertTrue(man["neverCopy"], "control: the manifest has neverCopy entries to compile")
        for g in man["neverCopy"]:
            with self.subTest(g=g):
                self.ep.glob_to_re(g)


class ManifestTest(unittest.TestCase):
    """Pins that every path in the manifest's include exists in the current
    layout."""

    def test_every_include_exists(self):
        # A full extraction does not necessarily run with every test; the
        # ordinary suite must refuse a drifted include first.
        import json
        man = json.loads((PKG / "perch-package.json").read_text())
        src_root = ROOT if (ROOT / "apps" / "mac-widget" / "Perch").is_dir() else PKG
        missing = [i for i in man["include"] if not (src_root / i).exists()]
        self.assertEqual(missing, [], f"manifest lists paths that do not exist: {missing}")


if __name__ == "__main__":
    unittest.main()
