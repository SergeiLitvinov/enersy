import importlib.util
import copy
import io
import json
import tarfile
import tempfile
import unittest
import subprocess
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("notice_updater", Path(__file__).with_name("update-julia-notices.py"))
UPDATER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(UPDATER)
PROOF_SPEC = importlib.util.spec_from_file_location("lld_packaging", Path(__file__).with_name("verify-julia-lld-packaging.py"))
PROOF = importlib.util.module_from_spec(PROOF_SPEC)
PROOF_SPEC.loader.exec_module(PROOF)


class SdkImageReadTests(unittest.TestCase):
    def test_arm64_facts_require_their_own_reviewed_product_identity(self):
        target = PROOF.reviewed_target(PROOF.ARM64_PLATFORM)
        facts = {"formatVersion": 1, "scope": "julia-sdk-notice-facts", "juliaVersion": PROOF.VERSION,
            "juliaCommit": PROOF.COMMIT, "platform": target['platform'],
            "components": [{"uuid": PROOF.UUID, "name": "LLD_jll", "version": "20.1.8+2", "metadataSha256": PROOF.METADATA_SHA}],
            "executables": [{"file": PROOF.SDK_FILE, "sha256": target['sdkSha256'], "bytes": target['sdkBytes'], "component": "LLD_jll"}]}
        self.assertEqual(PROOF.validate_facts(facts), target)
        wrong = copy.deepcopy(facts); wrong['executables'][0]['sha256'] = PROOF.SDK_SHA
        with self.assertRaisesRegex(ValueError, 'identity changed'):
            PROOF.validate_facts(wrong)
        wrong = copy.deepcopy(facts); wrong['platform'] = 'aarch64-other-unreviewed'
        with self.assertRaisesRegex(ValueError, 'exact reviewed'):
            PROOF.validate_facts(wrong)

    def test_arm64_metadata_cannot_select_the_asserts_variant_or_amd64_archive(self):
        target = PROOF.reviewed_target(PROOF.ARM64_PLATFORM)
        data = ('[[LLD]]\narch="aarch64"\nos="linux"\nlibc="glibc"\ncxxstring_abi="cxx11"\nllvm_version="20"\n'
            f'[[LLD.download]]\nurl="{target["archiveUrl"]}"\nsha256="{target["archiveSha256"]}"\n').encode()
        with patch.object(PROOF, 'METADATA_SHA', UPDATER.sha256(data)):
            PROOF.validate_metadata(data, target)
            with self.assertRaisesRegex(ValueError, 'not declared'):
                PROOF.validate_metadata(data)
        changed = data.replace(b'"20"', b'"20.asserts"')
        with patch.object(PROOF, 'METADATA_SHA', UPDATER.sha256(changed)), self.assertRaisesRegex(ValueError, 'not declared'):
            PROOF.validate_metadata(changed, target)

    def test_sdk_inputs_are_copied_from_a_container_that_is_never_started(self):
        commands = []
        def docker(command, **_options):
            commands.append(command)
            if command[1] == 'create':
                return SimpleNamespace(stdout='a' * 64)
            if command[1] == 'cp':
                Path(command[-1]).write_bytes(b'metadata' if command[-1].endswith('StdlibArtifacts.toml') else b'lld')
            return SimpleNamespace(stdout='')
        with tempfile.TemporaryDirectory() as temporary, patch.object(PROOF.subprocess, 'run', side_effect=docker):
            metadata, product = PROOF.copy_sdk_inputs('sha256:' + 'b' * 64, Path(temporary))
            self.assertEqual(metadata, b'metadata')
            self.assertEqual(product.read_bytes(), b'lld')
        self.assertEqual([command[1] for command in commands], ['create', 'cp', 'cp', 'rm'])
        self.assertEqual(commands[-1], ['docker', 'rm', 'a' * 64])

    def test_sdk_copy_failure_still_removes_only_the_created_container(self):
        commands = []
        def docker(command, **_options):
            commands.append(command)
            if command[1] == 'create':
                return SimpleNamespace(stdout='a' * 64)
            if command[1] == 'cp':
                raise subprocess.CalledProcessError(1, command)
            return SimpleNamespace(stdout='')
        with tempfile.TemporaryDirectory() as temporary, patch.object(PROOF.subprocess, 'run', side_effect=docker):
            with self.assertRaises(subprocess.CalledProcessError):
                PROOF.copy_sdk_inputs('sha256:' + 'b' * 64, Path(temporary))
        self.assertEqual([command[1] for command in commands], ['create', 'cp', 'rm'])
        self.assertEqual(commands[-1], ['docker', 'rm', 'a' * 64])


class JuliaNoticeMaintenanceTests(unittest.TestCase):
    def test_ca_data_provenance_is_checked_before_refresh_writes_or_downloads(self):
        security = Path(__file__).parent
        reviewed = json.loads((security / "julia-notice-sources.json").read_text())
        reference = reviewed["sdkDataSources"][0]
        record = json.loads((security / "julia-notices" / reference["file"]).read_text())
        product = {key: record[key] for key in ("componentName", "componentUUID", "componentVersion", "projectSha256", "stubSha256", "sdkFile", "sdkSha256", "sdkSha512", "sdkBytes")}
        facts = {"formatVersion": 1, "scope": "julia-sdk-notice-facts", "platform": record["runtimePlatform"],
            "juliaVersion": record["juliaVersion"], "juliaCommit": record["juliaCommit"], "dataProducts": [product], "components": []}
        reviewed["artifactPlatformBindings"] = []
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            root = repo / "scripts/security/julia-notices"
            for relative in [reference["file"], record["metadataFile"], record["checksumFile"], record["noticeFiles"][0]["file"]]:
                file = root / relative
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes((security / "julia-notices" / relative).read_bytes())
            config_file = root.parent / "julia-notice-sources.json"
            config_file.write_text(json.dumps(reviewed))
            self.assertEqual(UPDATER.verify_sdk_data_sources(repo, facts, reviewed), [reference])
            self.assertEqual(UPDATER.verify_sdk_data_sources(repo, {**facts, "platform": "other-platform"}, reviewed), [])
            source = root / reference["file"]
            source.write_bytes(b"changed")
            (root / "index.json").write_bytes(b"Do not overwrite")
            with patch.object(UPDATER, "download") as download, self.assertRaisesRegex(ValueError, "checksum"):
                UPDATER.refresh(repo, facts)
            download.assert_not_called()
            self.assertEqual((root / "index.json").read_bytes(), b"Do not overwrite")
            for key, value in (("formatVersion", True), ("scope", "wrong"), ("originKind", "sdk-artifact"),
                    ("juliaCommit", "0" * 40), ("projectSha256", "0" * 64), ("artifactSha256", "0" * 64),
                    ("archiveUrl", "https://example.invalid/archive"), ("archiveBytes", False),
                    ("metadataUrl", "https://example.invalid/Artifacts.toml"), ("checksumUrl", "https://example.invalid/sha512"),
                    ("metadataGitBlobSha1", "0" * 40), ("checksumGitBlobSha1", "0" * 40),
                    ("metadataGitBlobSha1", None), ("checksumGitBlobSha1", None), ("artifactBytes", 188900.0),
                    ("licenseExpression", "MIT"), ("noticeFiles", []), ("extra", "unsupported")):
                changed = copy.deepcopy(record)
                changed[key] = value
                source.write_text(json.dumps(changed))
                reference["sha256"] = UPDATER.file_hash(source)
                with self.subTest(key=key), self.assertRaises(ValueError):
                    UPDATER.verify_sdk_data_sources(repo, facts, reviewed)
            source.write_bytes((security / "julia-notices" / reference["file"]).read_bytes())
            reference["sha256"] = UPDATER.file_hash(source)
            (root / record["noticeFiles"][0]["file"]).write_text("Changed license")
            with self.assertRaisesRegex(ValueError, "checksum"):
                UPDATER.verify_sdk_data_sources(repo, facts, reviewed)

    def test_reviewed_repackaging_receipt_is_checked_before_downloads(self):
        security = Path(__file__).parent
        reviewed = json.loads((security / "julia-notice-sources.json").read_text())
        binding = next(row for row in reviewed["artifactPlatformBindings"] if "repackagingProof" in row)
        receipt_bytes = (security / "julia-notices" / binding["repackagingProof"]["file"]).read_bytes()
        receipt = json.loads(receipt_bytes)
        facts = {"formatVersion": 1, "scope": "julia-sdk-notice-facts", "juliaVersion": receipt["juliaVersion"],
            "juliaCommit": receipt["juliaCommit"], "platform": receipt["platform"], "libraries": [],
            "executables": [{"file": receipt["sdkFile"], "sha256": receipt["sdkSha256"], "bytes": receipt["sdkBytes"]}],
            "components": [{"uuid": binding["componentUUID"], "version": binding["componentVersion"], "metadataSha256": binding["metadataSha256"],
                "artifacts": [{"name": "LLD", "platformBinding": binding,
                    "selected": {"download": [{"url": receipt["archiveUrl"], "sha256": receipt["archiveSha256"]}]}}]}]}
        reviewed["artifactPlatformBindings"] = [binding]
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            root = repo / "scripts/security/julia-notices"
            file = root / binding["repackagingProof"]["file"]
            file.parent.mkdir(parents=True)
            file.write_bytes(receipt_bytes)
            (root.parent / "julia-notice-sources.json").write_text(json.dumps(reviewed))
            self.assertEqual(UPDATER.load_repackaging_proofs(repo, facts, reviewed), {(binding["componentUUID"], "LLD"): receipt})
            file.write_bytes(b"changed")
            with patch.object(UPDATER, "download") as download, self.assertRaisesRegex(ValueError, "checksum"):
                UPDATER.refresh(repo, facts)
            download.assert_not_called()
            self.assertFalse((root / "index.json").exists())
            for key, value in (("formatVersion", True), ("scope", "wrong"), ("juliaCommit", "0" * 40), ("metadataSha256", "0" * 64),
                    ("tool", {}), ("operation", ["patchelf", "--add-rpath", "wrong"]), ("reproducedSha256", "0" * 64),
                    ("reproducedBytes", 1), ("sameBytesAfterRepackaging", False), ("sdkImageId", "latest"),
                    ("archiveUrl", "https://example.invalid/other.tar.gz"), ("extra", "unsupported")):
                changed = copy.deepcopy(receipt)
                changed[key] = value
                file.write_text(json.dumps(changed))
                binding["repackagingProof"]["sha256"] = UPDATER.file_hash(file)
                with self.subTest(key=key), self.assertRaises(ValueError):
                    UPDATER.load_repackaging_proofs(repo, facts, reviewed)

    def test_lld_repackaging_proof_is_scoped_to_exact_sdk_identity(self):
        facts = {"formatVersion": 1, "scope": "julia-sdk-notice-facts", "juliaVersion": PROOF.VERSION,
            "juliaCommit": PROOF.COMMIT, "platform": PROOF.PLATFORM,
            "components": [{"uuid": PROOF.UUID, "name": "LLD_jll", "version": "20.1.8+2", "metadataSha256": PROOF.METADATA_SHA}],
            "executables": [{"file": PROOF.SDK_FILE, "sha256": PROOF.SDK_SHA, "bytes": 7515760, "component": "LLD_jll"}]}
        PROOF.validate_facts(facts)
        for field in ("formatVersion", "scope", "juliaVersion", "juliaCommit", "platform"):
            changed = copy.deepcopy(facts)
            changed[field] = "changed"
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "exact reviewed"):
                PROOF.validate_facts(changed)
        for section, field in (("components", "uuid"), ("components", "name"), ("components", "version"),
                ("components", "metadataSha256"), ("executables", "file"), ("executables", "sha256"),
                ("executables", "bytes"), ("executables", "component")):
            changed = copy.deepcopy(facts)
            changed[section][0][field] = "changed"
            with self.subTest(section=section, field=field), self.assertRaises(ValueError):
                PROOF.validate_facts(changed)
        for section in ("components", "executables"):
            for rows in ([], facts[section] * 2):
                changed = copy.deepcopy(facts)
                changed[section] = rows
                with self.subTest(section=section, rows=len(rows)), self.assertRaises(ValueError):
                    PROOF.validate_facts(changed)

    def test_lld_repackaging_uses_an_archive_declared_by_sdk_metadata(self):
        metadata = ('[[LLD]]\narch="x86_64"\nos="linux"\nlibc="glibc"\ncxxstring_abi="cxx11"\nllvm_version="20"\n'
            f'[[LLD.download]]\nurl="{PROOF.ARCHIVE_URL}"\nsha256="{PROOF.ARCHIVE_SHA}"\n').encode()
        with patch.object(PROOF, "METADATA_SHA", UPDATER.sha256(metadata)):
            PROOF.validate_metadata(metadata)
            with self.assertRaisesRegex(ValueError, "differs"):
                PROOF.validate_metadata(metadata + b"\n")
        for before, after in ((b'"20"', b'"20.asserts"'), (PROOF.ARCHIVE_SHA.encode(), b"0" * 64)):
            changed = metadata.replace(before, after)
            with patch.object(PROOF, "METADATA_SHA", UPDATER.sha256(changed)), self.assertRaisesRegex(ValueError, "not declared"):
                PROOF.validate_metadata(changed)

    def test_lld_repackaging_refuses_links_duplicates_and_changed_product_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data = b"x" * 7511664
            archive = self.archive(root, [("tools/lld", data, tarfile.REGTYPE)])
            with patch.object(PROOF, "ARCHIVE_SHA", UPDATER.file_hash(archive)), patch.object(PROOF, "SOURCE_SHA", UPDATER.sha256(data)):
                self.assertEqual(PROOF.artifact_product(archive), data)
            with patch.object(PROOF, "ARCHIVE_SHA", UPDATER.file_hash(archive)), self.assertRaisesRegex(ValueError, "product checksum"):
                PROOF.artifact_product(archive)
            for entries in ([ ("tools/lld", b"x", tarfile.REGTYPE) ],
                    [ ("tools/lld", b"", tarfile.SYMTYPE) ],
                    [ ("tools/lld", b"", tarfile.REGTYPE) ] * 2):
                archive = self.archive(root, entries)
                with patch.object(PROOF, "ARCHIVE_SHA", UPDATER.file_hash(archive)), self.assertRaisesRegex(ValueError, "product is"):
                    PROOF.artifact_product(archive)
            with self.assertRaisesRegex(ValueError, "archive checksum"):
                PROOF.artifact_product(archive)

    def test_lld_repackaging_requires_exact_reproduced_output_without_links(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "lld"
            output.write_bytes(b"x" * 7515760)
            expected = UPDATER.file_hash(output)
            with self.assertRaisesRegex(ValueError, "not byte-identical"):
                PROOF.verify_output(output)
            with patch.object(PROOF, "SDK_SHA", expected):
                report = PROOF.verify_output(output)
                self.assertTrue(report["sameBytesAfterRepackaging"])
                self.assertEqual(report["reproducedSha256"], expected)
                self.assertEqual(report["operation"], ["patchelf", "--set-rpath", "$ORIGIN/../../lib/julia"])
                linked = root / "linked"
                linked.symlink_to(output)
                with self.assertRaises(ValueError):
                    PROOF.verify_output(linked)
                output.write_bytes(b"short")
                with self.assertRaises(ValueError):
                    PROOF.verify_output(output)
                output.unlink()
                with self.assertRaises(ValueError):
                    PROOF.verify_output(output)
            with self.assertRaisesRegex(ValueError, "commas"):
                PROOF.mount(root / "unusable,mount", "/inputs/lld")

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

    def test_executable_products_are_hashed_but_not_extracted_or_executed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = b"#!/bin/sh\nexit 99 # must never execute\n"
            archive = self.archive(root, [("tools/lld", binary, tarfile.REGTYPE)])
            output = root / "notices"
            files, comparisons = UPDATER.extract_notices(archive, output, "a" * 64,
                [{"file": "libexec/julia/lld", "sha256": UPDATER.sha256(binary)}])
            self.assertEqual(files, [])
            self.assertEqual(comparisons, [{"sdkFile": "libexec/julia/lld", "archivePath": "tools/lld",
                "sdkSha256": UPDATER.sha256(binary), "artifactSha256": UPDATER.sha256(binary), "sameBytes": True}])
            self.assertFalse(output.exists())

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
