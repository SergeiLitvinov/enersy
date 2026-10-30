"""Refresh reviewed Julia notices. Python is a maintenance tool, not an app runtime.

Uses an existing Docker image to select SDK artifacts, downloads checksum-pinned
archives and copies only notice text. Archives and binary products stay in .cache.
"""

import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import subprocess
import tarfile
import tempfile
import threading
import tomllib
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

MAX_ARCHIVE = 512 * 1024 * 1024
MAX_NOTICE = 4 * 1024 * 1024
HEX64 = re.compile(r"[a-f0-9]{64}\Z")
ALLOWED_HOSTS = {
    "github.com", "raw.githubusercontent.com", "objects.githubusercontent.com",
    "release-assets.githubusercontent.com", "api.github.com",
}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def file_hash(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def git_blob_hash(data):
    return hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        validate_url(new_url)
        return super().redirect_request(request, response, code, message, headers, new_url)


def validate_url(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS or parsed.username or parsed.password or parsed.port:
        raise ValueError("Unsupported notice download URL")


def download(url, file, expected=None):
    validate_url(url)
    if file.exists():
        if expected is not None and file_hash(file) != expected:
            raise ValueError("Cached artifact checksum mismatch")
        return file
    file.parent.mkdir(parents=True, exist_ok=True)
    partial = file.with_suffix(file.suffix + ".part")
    opener = urllib.request.build_opener(SafeRedirect())
    request = urllib.request.Request(url, headers={"User-Agent": "Enersy-notice-maintenance/1"})
    count = 0
    digest = hashlib.sha256()
    with opener.open(request, timeout=60) as response, partial.open("wb") as output:
        while block := response.read(1024 * 1024):
            count += len(block)
            if count > MAX_ARCHIVE:
                raise ValueError("Notice source archive exceeds maintenance limit")
            digest.update(block)
            output.write(block)
    if expected is not None and digest.hexdigest() != expected:
        raise ValueError("Downloaded artifact checksum mismatch")
    os.replace(partial, file)
    return file


def safe_parts(name):
    if "\\" in name or any(ord(char) < 32 for char in name):
        raise ValueError("Unsupported archive path")
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError("Archive path escapes its source")
    for part in path.parts:
        if re.search(r'[<>:"|?*]', part) or part.endswith((".", " ")) or re.fullmatch(r"(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", part):
            raise ValueError("Archive path is unsafe on Windows")
    return path.parts


def write_immutable(root, relative, data):
    parts = safe_parts(relative)
    if not parts:
        raise ValueError("Empty notice path")
    target = root.joinpath(*parts)
    if not target.resolve().is_relative_to(root.resolve()):
        raise ValueError("Notice destination escapes its directory")
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        if target.read_bytes() != data:
            raise ValueError("Existing reviewed notice differs; review before replacing it")
    else:
        target.write_bytes(data)
    return {"file": PurePosixPath(*parts).as_posix(), "sha256": sha256(data), "bytes": len(data)}


def extract_notices(archive, output, archive_sha, sdk_libraries):
    by_basename = {}
    for library in sdk_libraries:
        by_basename.setdefault(PurePosixPath(library["file"]).name, []).append(library)
    notices, comparisons = [], []
    seen_notices = set()
    expanded = 0
    with tarfile.open(archive, "r:gz") as stream:
        for member in stream:
            parts = safe_parts(member.name)
            if not parts:
                if member.isdir():
                    continue
                raise ValueError("Archive contains an unnamed entry")
            expanded += max(member.size, 0)
            if expanded > 2 * 1024 * 1024 * 1024:
                raise ValueError("Artifact expands beyond maintenance limit")
            is_notice = parts[:2] == ("share", "licenses")
            if is_notice:
                if member.isdir():
                    continue
                if not member.isfile() or member.size == 0 or member.size > MAX_NOTICE:
                    raise ValueError("Notice is empty, oversized or not a regular file")
                name = PurePosixPath(*parts).as_posix()
                if name in seen_notices:
                    raise ValueError("Duplicate notice in artifact")
                seen_notices.add(name)
                with stream.extractfile(member) as source:
                    data = source.read(MAX_NOTICE + 1)
                if len(data) != member.size:
                    raise ValueError("Truncated artifact notice")
                data.decode("utf-8", errors="strict")
                captured = write_immutable(output, f"artifacts/{archive_sha}/{name}", data)
                notices.append({"archivePath": name, **captured})
            elif member.isfile() and parts[-1] in by_basename:
                with stream.extractfile(member) as source:
                    artifact_hash = hashlib.file_digest(source, "sha256").hexdigest()
                for library in by_basename[parts[-1]]:
                    comparisons.append({"sdkFile": library["file"], "archivePath": PurePosixPath(*parts).as_posix(),
                        "sdkSha256": library["sha256"], "artifactSha256": artifact_hash,
                        "sameBytes": library["sha256"] == artifact_hash})
    return sorted(notices, key=lambda item: item["file"]), sorted(comparisons, key=lambda item: (item["sdkFile"], item["archivePath"]))


def get_facts(repo, image):
    script = repo / "scripts/security/collect_julia_licenses.jl"
    config = repo / "scripts/security/julia-notice-sources.json"
    command = ["docker", "run", "--rm", "--network", "none", "--mount",
        f"type=bind,source={script},target=/collect.jl,readonly", "--mount",
        f"type=bind,source={config},target=/notice-config.json,readonly", image,
        "julia", "--project=.", "--startup-file=no", "/collect.jl", "--facts", "/notice-config.json"]
    result = subprocess.run(command, check=False, capture_output=True, encoding="utf-8")
    if result.returncode != 0:
        raise RuntimeError(f"Unable to inspect SDK facts (Docker exit {result.returncode}):\n{result.stderr.strip()}")
    return json.loads(result.stdout)


def source_index_path(output, platform, scoped=False):
    if not isinstance(platform, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_.+\-]{0,199}", platform) or "-" not in platform or platform.endswith("."):
        raise ValueError("Invalid Julia SDK platform triplet")
    index = output / "platforms" / platform / "index.json" if scoped else output / "index.json"
    if not index.resolve().is_relative_to(output.resolve()):
        raise ValueError("Notice index escapes source directory")
    if scoped and index.resolve() != output.resolve() / "platforms" / platform / "index.json":
        raise ValueError("Scoped notice index aliases another source path")
    if index.exists():
        existing = json.loads(index.read_text(encoding="utf-8"))
        if existing.get("platform") != platform:
            raise ValueError("Refusing to replace another platform's notice index; use --scoped-index")
    return index


def verify_fact_bindings(facts, reviewed):
    expected = {}
    for binding in reviewed.get("artifactPlatformBindings", []):
        if binding["runtimePlatform"] != facts["platform"]:
            continue
        identity = (binding["componentUUID"], binding["artifact"])
        if identity in expected:
            raise ValueError("Duplicate reviewed artifact binding")
        expected[identity] = binding
    seen = set()
    for component in facts["components"]:
        for artifact in component["artifacts"]:
            binding = artifact.get("platformBinding")
            if binding is None:
                continue
            identity = (component["uuid"], artifact["name"])
            if identity in seen or expected.get(identity) != binding:
                raise ValueError("Unreviewed or duplicate binding in SDK facts")
            if component["version"] != binding["componentVersion"] or component["metadataSha256"] != binding["metadataSha256"] or not any(
                    row["file"] == binding["sdkFile"] and row["sha256"] == binding["sdkSha256"] for row in facts["libraries"] + facts.get("executables", [])):
                raise ValueError("Bound SDK facts identity changed")
            selected = artifact["selected"]
            if not selected or not any(row["sha256"] == binding["archiveSha256"] for row in selected.get("download", [])):
                raise ValueError("Bound SDK facts archive changed")
            seen.add(identity)
    if seen != set(expected):
        raise ValueError("SDK facts lack reviewed bindings; recapture with --facts CONFIG")


def load_repackaging_proofs(repo, facts, reviewed):
    root = repo / "scripts/security/julia-notices"
    proofs = {}
    for binding in reviewed.get("artifactPlatformBindings", []):
        if binding["runtimePlatform"] != facts["platform"] or "repackagingProof" not in binding:
            continue
        reference = binding["repackagingProof"]
        if set(reference) != {"file", "sha256"} or not HEX64.fullmatch(reference["sha256"]):
            raise ValueError("Invalid repackaging proof reference")
        parts = safe_parts(reference["file"])
        file = root.joinpath(*parts)
        if not parts or parts[0] != "packaging" or not file.resolve().is_relative_to(root.resolve()):
            raise ValueError("Repackaging proof escapes its source directory")
        if not file.is_file() or not 0 < file.stat().st_size <= 65536 or file_hash(file) != reference["sha256"]:
            raise ValueError("Repackaging proof checksum/size mismatch")
        proof = json.loads(file.read_text(encoding="utf-8"))
        required = {"formatVersion", "scope", "juliaVersion", "juliaCommit", "platform", "componentUUID", "metadataSha256",
            "archiveUrl", "archiveSha256", "artifactFile", "artifactSha256", "sdkFile", "sdkSha256", "sdkBytes", "tool", "operation",
            "reproducedSha256", "reproducedBytes", "sameBytesAfterRepackaging", "sdkImageId", "builderImageId"}
        if set(proof) != required or type(proof["formatVersion"]) is not int or proof["formatVersion"] != 1 or proof["scope"] != "julia-lld-repackaging-verification":
            raise ValueError("Unsupported repackaging proof schema")
        if any(proof[key] != facts[key] for key in ("juliaVersion", "juliaCommit", "platform")) or any(
                proof[key] != binding[key] for key in ("componentUUID", "metadataSha256", "archiveSha256", "artifactFile", "sdkFile", "sdkSha256")):
            raise ValueError("Repackaging proof binding/runtime mismatch")
        if (binding["componentUUID"], binding["artifact"], binding["tags"], binding["sdkFile"], binding["artifactFile"]) != (
                "d55e3150-da41-5e91-b323-ecfd1eec6109", "LLD", {"llvm_version": "20"}, "libexec/julia/lld", "tools/lld"):
            raise ValueError("Unsupported SDK repackaging product")
        if proof["tool"] != {"version": "0.17.2", "sourceUrl": "https://github.com/NixOS/patchelf/releases/download/0.17.2/patchelf-0.17.2.tar.bz2",
                "sourceSha512": "8277adf95513f88fb190536a38bdfdf438a4cc7685d8a130bdffbe064441f0f25095b6c83bbb190133e1a138963776d15b46c247dd2f1a073a1bfe1d1dbdd503"} or proof["operation"] != ["patchelf", "--set-rpath", "$ORIGIN/../../lib/julia"]:
            raise ValueError("Unsupported SDK repackaging operation/tool")
        if any(not isinstance(proof[key], str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", proof[key]) for key in ("sdkImageId", "builderImageId")):
            raise ValueError("Invalid proof image identity")
        if not HEX64.fullmatch(proof["artifactSha256"]) or proof["artifactSha256"] == binding["sdkSha256"] or proof["sameBytesAfterRepackaging"] is not True or (
                proof["reproducedSha256"] != binding["sdkSha256"] or type(proof["sdkBytes"]) is not int or proof["sdkBytes"] <= 0 or proof["reproducedBytes"] != proof["sdkBytes"]):
            raise ValueError("Invalid reproduced SDK identity")
        if not any(row["file"] == binding["sdkFile"] and row["sha256"] == binding["sdkSha256"] and row["bytes"] == proof["sdkBytes"] for row in facts.get("executables", [])):
            raise ValueError("Repackaging proof executable changed")
        selected = [artifact["selected"] for component in facts["components"] if component["uuid"] == binding["componentUUID"]
            for artifact in component["artifacts"] if artifact["name"] == binding["artifact"]]
        if len(selected) != 1 or not selected[0] or not any(row["url"] == proof["archiveUrl"] and row["sha256"] == proof["archiveSha256"] for row in selected[0].get("download", [])):
            raise ValueError("Repackaging proof archive is not selected by SDK facts")
        proofs[(binding["componentUUID"], binding["artifact"])] = proof
    return proofs


def verify_sdk_data_sources(repo, facts, reviewed):
    root = repo / "scripts/security/julia-notices"
    references = reviewed.get("sdkDataSources", [])
    if not isinstance(references, list) or len(references) > 64:
        raise ValueError("Invalid SDK data source references")
    active, seen, products_seen = [], set(), set()

    def checked(relative, checksum, blob=None, max_bytes=65536):
        path = root.joinpath(*safe_parts(relative))
        if not path.resolve().is_relative_to(root.resolve()) or not path.is_file() or not 0 < path.stat().st_size <= max_bytes:
            raise ValueError("SDK data provenance path/size mismatch")
        data = path.read_bytes()
        if sha256(data) != checksum or (blob is not None and git_blob_hash(data) != blob):
            raise ValueError("SDK data provenance checksum/Git blob mismatch")
        return data

    for reference in references:
        if set(reference) != {"runtimePlatform", "file", "sha256"} or not HEX64.fullmatch(reference["sha256"]) or safe_parts(reference["file"])[:1] != ("data",):
            raise ValueError("Invalid SDK data source reference")
        platform = reference["runtimePlatform"]
        if not isinstance(platform, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_.+\-]{0,199}", platform) or "-" not in platform or platform.endswith("."):
            raise ValueError("Invalid SDK data source platform")
        identity = (platform, reference["file"])
        if identity in seen:
            raise ValueError("Duplicate SDK data source reference")
        seen.add(identity)
        if platform != facts["platform"]:
            continue
        record = json.loads(checked(reference["file"], reference["sha256"]))
        fields = set(("formatVersion scope originKind runtimePlatform juliaVersion juliaCommit componentName componentUUID componentVersion "
            "projectSha256 stubSha256 sdkFile sdkSha256 sdkSha512 sdkBytes archiveUrl archiveSha256 archiveBytes artifactFile artifactSha256 "
            "artifactSha512 artifactBytes metadataFile metadataUrl metadataSha256 metadataGitBlobSha1 artifactTreeSha1 checksumFile checksumUrl "
            "checksumSha256 checksumGitBlobSha1 licenseExpression noticeFiles").split())
        if set(record) != fields or type(record["formatVersion"]) is not int or record["formatVersion"] != 1 or record["scope"] != "julia-sdk-reviewed-data-source" or record["originKind"] != "reviewed-upstream-jll":
            raise ValueError("Unsupported SDK data source schema")
        if (record["componentUUID"], record["componentName"], record["sdkFile"], record["artifactFile"], record["licenseExpression"]) != (
                "14a3606d-f60d-562e-9121-12d972cd8159", "MozillaCACerts_jll", "share/julia/cert.pem", "share/cacert.pem", "MPL-2.0"):
            raise ValueError("Unsupported SDK data source product")
        if record["componentUUID"] in products_seen:
            raise ValueError("Duplicate SDK data product source")
        products_seen.add(record["componentUUID"])
        if (record["runtimePlatform"], record["juliaVersion"], record["juliaCommit"]) != (facts["platform"], facts["juliaVersion"], facts["juliaCommit"]):
            raise ValueError("SDK data source runtime changed")
        keys = ("componentName", "componentUUID", "componentVersion", "projectSha256", "stubSha256", "sdkFile", "sdkSha256", "sdkSha512", "sdkBytes")
        if not any(all(product[key] == record[key] for key in keys) for product in facts.get("dataProducts", [])):
            raise ValueError("SDK data product changed")
        if record["sdkSha256"] != record["artifactSha256"] or record["sdkSha512"] != record["artifactSha512"] or record["sdkBytes"] != record["artifactBytes"]:
            raise ValueError("SDK data differs from reviewed archive product")
        if any(type(record[key]) is not int or record[key] <= 0 for key in ("sdkBytes", "artifactBytes", "archiveBytes")):
            raise ValueError("Invalid SDK data source size")
        if any(not isinstance(record[key], str) or not re.fullmatch(r"[a-f0-9]{40}", record[key]) for key in ("metadataGitBlobSha1", "checksumGitBlobSha1", "artifactTreeSha1")):
            raise ValueError("Invalid SDK data Git identity")
        for key in ("metadataFile", "checksumFile"):
            if safe_parts(record[key])[:1] != ("data",):
                raise ValueError("SDK data provenance path mismatch")
        if not re.fullmatch(r"https://raw.githubusercontent.com/JuliaBinaryWrappers/MozillaCACerts_jll.jl/[a-f0-9]{40}/Artifacts.toml", record["metadataUrl"]):
            raise ValueError("Unreviewed SDK data metadata URL")
        date = record["componentVersion"].replace(".", "-")
        if record["checksumUrl"] != f"https://raw.githubusercontent.com/JuliaLang/julia/{facts['juliaCommit']}/deps/checksums/cacert-{date}.pem/sha512":
            raise ValueError("Unreviewed SDK data build checksum URL")
        metadata = tomllib.loads(checked(record["metadataFile"], record["metadataSha256"], record["metadataGitBlobSha1"]).decode())["MozillaCACerts"]
        if metadata["git-tree-sha1"] != record["artifactTreeSha1"] or not any(row["url"] == record["archiveUrl"] and row["sha256"] == record["archiveSha256"] for row in metadata["download"]):
            raise ValueError("SDK data archive is not declared by reviewed metadata")
        if checked(record["checksumFile"], record["checksumSha256"], record["checksumGitBlobSha1"]).decode().strip() != record["sdkSha512"]:
            raise ValueError("SDK data differs from Julia build checksum")
        if not record["noticeFiles"]:
            raise ValueError("SDK data license notices missing")
        for notice in record["noticeFiles"]:
            archive_path = "/".join(safe_parts(notice["archivePath"]))
            if not archive_path.startswith("share/licenses/MozillaCACerts/") or notice["file"] != f"artifacts/{record['archiveSha256']}/{archive_path}":
                raise ValueError("SDK data notice source mismatch")
            data = checked(notice["file"], notice["sha256"], max_bytes=4 * 1024 * 1024)
            data.decode("utf-8", errors="strict")
            if len(data) != notice["bytes"]:
                raise ValueError("SDK data notice size mismatch")
        active.append(reference)
    return active


def refresh(repo, facts, jobs=3, scoped_index=False):
    if facts.get("formatVersion") != 1 or facts.get("scope") != "julia-sdk-notice-facts":
        raise ValueError("Unsupported Julia SDK facts")
    reviewed = json.loads((repo / "scripts/security/julia-notice-sources.json").read_text(encoding="utf-8"))
    if facts["juliaCommit"] != reviewed["juliaCommit"] or facts["juliaVersion"] != reviewed["juliaVersion"]:
        raise ValueError("Julia runtime requires a reviewed third-party source record")
    verify_fact_bindings(facts, reviewed)
    proofs = load_repackaging_proofs(repo, facts, reviewed)
    data_references = verify_sdk_data_sources(repo, facts, reviewed)
    output = repo / "scripts/security/julia-notices"
    cache = repo / ".cache/julia-license-artifacts"
    if not output.resolve().is_relative_to(repo.resolve()) or not cache.resolve().is_relative_to(repo.resolve()):
        raise ValueError("Maintenance directories escape repository")
    # Validate before any downloads or writes to preserve the reviewed root
    # inventory when inspecting a runtime for a different architecture.
    source_index_path(output, facts["platform"], scoped_index)
    runtime_source = reviewed["thirdParty"]
    thirdparty = download(runtime_source["url"], cache / f"thirdparty-{runtime_source['gitBlobSha1']}.md")
    data = thirdparty.read_bytes()
    data.decode("utf-8", errors="strict")
    if git_blob_hash(data) != runtime_source["gitBlobSha1"]:
        raise ValueError("Julia third-party index does not match reviewed Git blob")
    runtime_notice = write_immutable(output, "runtime/THIRDPARTY.md", data)
    runtime_notice.update(runtime_source)
    locks = {}
    for component in facts["components"]:
        for artifact in component["artifacts"]:
            if artifact["selected"]:
                for candidate in artifact["selected"].get("download", []):
                    checksum = candidate["sha256"]
                    if not HEX64.fullmatch(checksum):
                        raise ValueError("Invalid SDK artifact checksum")
                    locks.setdefault(checksum, threading.Lock())

    def collect_component(component):
        artifacts = []
        for artifact in component["artifacts"]:
            selected = artifact["selected"]
            if not selected:
                artifacts.append({"name": artifact["name"], "status": "no_host_artifact"})
                continue
            candidates = selected.get("download", [])
            if not candidates:
                raise ValueError("SDK artifact has no declared download")
            candidate = candidates[0]
            url, checksum = candidate["url"], candidate["sha256"]
            parsed = urllib.parse.urlsplit(url)
            if parsed.hostname != "github.com" or not re.match(r"/JuliaBinaryWrappers/[A-Za-z0-9_.+-]+/releases/download/", parsed.path):
                raise ValueError("Unreviewed SDK binary artifact source")
            with locks[checksum]:
                archive = download(url, cache / f"{checksum}.tar.gz", checksum)
                notice_files, comparisons = extract_notices(archive, output, checksum, facts["libraries"] + facts.get("executables", []))
            proof = proofs.get((component["uuid"], artifact["name"]))
            if proof and (proof["archiveUrl"] != url or not any(row["sdkFile"] == proof["sdkFile"] and row["archivePath"] == proof["artifactFile"] and
                    row["sdkSha256"] == proof["sdkSha256"] and row["artifactSha256"] == proof["artifactSha256"] and row["sameBytes"] is False for row in comparisons)):
                raise ValueError("Repackaging proof lacks matching original artifact comparison")
            record = {"name": artifact["name"], "treeSha1": selected["git-tree-sha1"],
                "archiveUrl": url, "archiveSha256": checksum, "archiveBytes": archive.stat().st_size,
                "noticeFiles": notice_files, "libraryComparisons": comparisons,
                "status": "notices_collected" if notice_files else "no_notice_files_in_artifact"}
            if artifact.get("platformBinding"):
                record["platformBinding"] = artifact["platformBinding"]
            if artifact.get("unboundPlatformTags"):
                record["unboundPlatformTags"] = artifact["unboundPlatformTags"]
            artifacts.append(record)
        result = {"name": component["name"], "uuid": component["uuid"], "version": component["version"],
            "metadataSha256": component["metadataSha256"], "artifacts": artifacts}
        count = sum(len(artifact.get("noticeFiles", [])) for artifact in artifacts)
        print(f"{component['name']}: {count} artifact notice files", flush=True)
        return result

    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
        components = list(pool.map(collect_component, facts["components"]))
    result = {"formatVersion": 1, "scope": "julia-sdk-reviewed-notice-sources",
        "sdkDataSources": data_references,
        "capturedUtc": datetime.now(timezone.utc).isoformat(), "juliaVersion": facts["juliaVersion"],
        "juliaCommit": facts["juliaCommit"], "platform": facts["platform"],
        "runtimeThirdParty": runtime_notice, "components": components}
    index = source_index_path(output, facts["platform"], scoped_index)
    index.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=index.parent, prefix=".index-", suffix=".part",
            encoding="utf-8", newline="\n", delete=False) as stream:
        partial = Path(stream.name)
        try:
            json.dump(result, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write("\n")
        except BaseException:
            stream.close()
            partial.unlink(missing_ok=True)
            raise
    try:
        os.replace(partial, index)
    finally:
        partial.unlink(missing_ok=True)
    print(f"Saved {len(components)} SDK component source records to {index.relative_to(repo)}", flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="enersy-julia-compute")
    parser.add_argument("--facts", type=Path, help="Previously captured SDK facts (offline discovery)")
    parser.add_argument("--jobs", type=int, choices=range(1, 5), default=3)
    parser.add_argument("--scoped-index", action="store_true", help="Write platforms/<runtime-triplet>/index.json without replacing the root platform index")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    facts = json.loads(args.facts.read_text(encoding="utf-8-sig")) if args.facts else get_facts(repo, args.image)
    refresh(repo, facts, args.jobs, args.scoped_index)


if __name__ == "__main__":
    main()
