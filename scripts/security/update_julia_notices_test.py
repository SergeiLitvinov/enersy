import importlib.util
import copy
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("notice_updater", Path(__file__).with_name("update-julia-notices.py"))
UPDATER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(UPDATER)


class JuliaNoticeMaintenanceTests(unittest.TestCase):
    def test_offline_facts_require_the_same_bound_sdk_and_archive(self):
        binding = {"runtimePlatform": "x86_64-linux-gnu", "componentUUID": "demo", "componentVersion": "1.0.0",
            "metadataSha256": "a" * 64, "artifact": "Demo", "sdkFile": "lib/demo.so", "sdkSha256": "b" * 64,
            "archiveSha256": "c" * 64}
        reviewed = {"artifactPlatformBindings": [binding]}
        artifact = {"name": "Demo", "platformBinding": binding, "selected": {"download": [{"sha256": "c" * 64}]}}
        component = {"uuid": "demo", "version": "1.0.0", "metadataSha256": "a" * 64, "artifacts": [artifact]}
        facts = {"platform": "x86_64-linux-gnu", "components": [component], "libraries": [{"file": "lib/demo.so", "sha256": "b" * 64}]}
        UPDATER.verify_fact_bindings(facts, reviewed)
        for field in ("missing", "library", "archive", "metadata", "duplicate"):
            bad = copy.deepcopy(facts)
            if field == "missing":
                del bad["components"][0]["artifacts"][0]["platformBinding"]
            elif field == "library":
                bad["libraries"][0]["sha256"] = "d" * 64
            elif field == "archive":
                bad["components"][0]["artifacts"][0]["selected"]["download"][0]["sha256"] = "d" * 64
            elif field == "metadata":
                bad["components"][0]["metadataSha256"] = "d" * 64
            else:
                bad["components"][0]["artifacts"].append(copy.deepcopy(artifact))
            with self.subTest(field=field), self.assertRaises(ValueError):
                UPDATER.verify_fact_bindings(bad, reviewed)
        with self.assertRaises(ValueError):
            UPDATER.verify_fact_bindings(facts, {})
        with self.assertRaises(ValueError):
            UPDATER.verify_fact_bindings(facts, {"artifactPlatformBindings": [binding, binding]})

    def test_refresh_scoped_index_preserves_default_and_checks_before_downloads(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            security = repo / "scripts/security"
            output = security / "julia-notices"
            output.mkdir(parents=True)
            original = b'{"platform":"x86_64-linux-gnu"}\n'
            (output / "index.json").write_bytes(original)
            text = b"Original third-party attribution\n"
            upstream = repo / "upstream.md"
            upstream.write_bytes(text)
            reviewed = {"juliaVersion": "1.13.2", "juliaCommit": "a" * 40,
                "thirdParty": {"url": "https://raw.githubusercontent.com/JuliaLang/julia/" + "a" * 40 + "/THIRDPARTY.md",
                    "gitBlobSha1": UPDATER.git_blob_hash(text)}}
            (security / "julia-notice-sources.json").write_text(json.dumps(reviewed), encoding="utf-8")
            facts = {"formatVersion": 1, "scope": "julia-sdk-notice-facts", "juliaVersion": "1.13.2",
                "juliaCommit": "a" * 40, "platform": "aarch64-linux-gnu", "components": [], "libraries": []}
            with patch.object(UPDATER, "download", return_value=upstream) as download:
                with self.assertRaisesRegex(ValueError, "another platform"):
                    UPDATER.refresh(repo, facts)
                download.assert_not_called()
                scoped = output / "platforms/aarch64-linux-gnu/index.json"
                scoped.parent.mkdir(parents=True)
                private = repo / "private.json"
                private.write_bytes(b"Do not overwrite an unrelated file")
                scoped.with_suffix(".json.part").symlink_to(private)
                result = UPDATER.refresh(repo, facts, scoped_index=True)
            self.assertEqual((output / "index.json").read_bytes(), original)
            self.assertEqual(json.loads((output / "platforms/aarch64-linux-gnu/index.json").read_text()), result)
            self.assertEqual((output / "runtime/THIRDPARTY.md").read_bytes(), text)
            self.assertEqual(private.read_bytes(), b"Do not overwrite an unrelated file")
            self.assertFalse(list(output.rglob(".index-*.part")))

    def test_platform_indexes_do_not_replace_another_reviewed_runtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = b'{"platform":"x86_64-linux-gnu"}\n'
            (root / "index.json").write_bytes(original)
            self.assertEqual(UPDATER.source_index_path(root, "x86_64-linux-gnu"), root / "index.json")
            with self.assertRaisesRegex(ValueError, "another platform"):
                UPDATER.source_index_path(root, "aarch64-linux-gnu")
            scoped = UPDATER.source_index_path(root, "aarch64-linux-gnu", scoped=True)
            self.assertEqual(scoped, root / "platforms/aarch64-linux-gnu/index.json")
            self.assertEqual((root / "index.json").read_bytes(), original)
            scoped.parent.mkdir(parents=True)
            scoped.write_text(json.dumps({"platform": "wrong-platform"}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "another platform"):
                UPDATER.source_index_path(root, "aarch64-linux-gnu", scoped=True)

    def test_platform_triplets_and_escaping_index_paths_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary, tempfile.TemporaryDirectory() as outside:
            root = Path(temporary)
            for platform in (None, "", "..", "NUL", "host", "../host-linux", "host/linux", "host\\linux", "host-linux\n", "host:linux", "host-linux.", "a-" + "b" * 200):
                with self.subTest(platform=platform), self.assertRaisesRegex(ValueError, "triplet"):
                    UPDATER.source_index_path(root, platform, scoped=True)
            (root / "platforms").symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "escapes"):
                UPDATER.source_index_path(root, "aarch64-linux-gnu", scoped=True)
            (root / "platforms").unlink()
            (root / "platforms").mkdir()
            (root / "index.json").write_text(json.dumps({"platform": "x86_64-linux-gnu"}), encoding="utf-8")
            (root / "platforms/x86_64-linux-gnu").symlink_to(root, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "aliases"):
                UPDATER.source_index_path(root, "x86_64-linux-gnu", scoped=True)

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
