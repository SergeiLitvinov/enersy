import importlib.util
import io
import tarfile
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("notice_updater", Path(__file__).with_name("update-julia-notices.py"))
UPDATER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(UPDATER)


class JuliaNoticeMaintenanceTests(unittest.TestCase):
    def archive(self, root, entries):
        file = root / "source.tar.gz"
        with tarfile.open(file, "w:gz") as output:
            for name, data, kind in entries:
                info = tarfile.TarInfo(name)
                info.type = kind
                info.size = len(data) if kind == tarfile.REGTYPE else 0
                if kind == tarfile.SYMTYPE:
                    info.linkname = "../../private.txt"
                output.addfile(info, io.BytesIO(data) if kind == tarfile.REGTYPE else None)
        return file

    def test_preserves_notice_bytes_and_compares_binaries_without_extracting_them(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            notice = "\ufeffCopyright © Авторы\r\nPermission and disclaimer\r\n".encode()
            binary = b"\x7fELFexample-binary"
            archive = self.archive(root, [
                ("./share/licenses/Demo/LICENSE", notice, tarfile.REGTYPE),
                ("lib/libdemo.so", binary, tarfile.REGTYPE),
                ("bin/unused.py", b"raise RuntimeError('must not execute')", tarfile.REGTYPE),
            ])
            destination = root / "notices"
            files, comparisons = UPDATER.extract_notices(archive, destination, "a" * 64,
                [{"file": "lib/julia/libdemo.so", "sha256": UPDATER.sha256(binary)}])
            self.assertEqual(len(files), 1)
            self.assertEqual((destination / files[0]["file"]).read_bytes(), notice)
            self.assertEqual(files[0]["sha256"], UPDATER.sha256(notice))
            self.assertTrue(comparisons[0]["sameBytes"])
            self.assertEqual([file for file in destination.rglob("*") if file.is_file()], [destination / files[0]["file"]])
            self.assertFalse((destination / "lib/libdemo.so").exists())

    def test_unsafe_paths_and_license_links_are_rejected(self):
        for name, kind in [("../private.txt", tarfile.REGTYPE),
                           ("C:/outside", tarfile.REGTYPE),
                           ("share/licenses/NUL", tarfile.REGTYPE),
                           ("share/licenses/Demo/LICENSE", tarfile.SYMTYPE)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                archive = self.archive(root, [(name, b"Text", kind)])
                with self.assertRaises(ValueError):
                    UPDATER.extract_notices(archive, root / "notices", "a" * 64, [])

    def test_duplicate_and_non_utf8_notices_are_rejected(self):
        for entries in [[("share/licenses/Demo/LICENSE", b"Text", tarfile.REGTYPE)] * 2,
                        [("share/licenses/Demo/LICENSE", b"\xff", tarfile.REGTYPE)]]:
            with self.subTest(entries=entries), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                archive = self.archive(root, entries)
                with self.assertRaises((ValueError, UnicodeError)):
                    UPDATER.extract_notices(archive, root / "notices", "a" * 64, [])

    def test_cached_archives_and_reviewed_files_cannot_be_replaced_silently(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "cached.tar.gz"
            archive.write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "Cached artifact checksum"):
                UPDATER.download("https://github.com/JuliaBinaryWrappers/Demo_jll.jl/releases/download/1/source.tar.gz", archive, "a" * 64)
            UPDATER.write_immutable(root, "notice/LICENSE", b"Reviewed")
            with self.assertRaisesRegex(ValueError, "Existing reviewed notice differs"):
                UPDATER.write_immutable(root, "notice/LICENSE", b"Replacement")
            self.assertEqual((root / "notice/LICENSE").read_bytes(), b"Reviewed")
        with self.assertRaises(ValueError):
            UPDATER.validate_url("https://example.invalid/source.tar.gz")


if __name__ == "__main__":
    unittest.main()
