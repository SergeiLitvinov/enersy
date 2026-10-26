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
import threading
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
    command = ["docker", "run", "--rm", "--network", "none", "--mount",
        f"type=bind,source={script},target=/collect.jl,readonly", image,
        "julia", "--project=.", "--startup-file=no", "/collect.jl", "--facts"]
    result = subprocess.run(command, check=True, capture_output=True, encoding="utf-8")
    return json.loads(result.stdout)


def refresh(repo, facts, jobs=3):
    if facts.get("formatVersion") != 1 or facts.get("scope") != "julia-sdk-notice-facts":
        raise ValueError("Unsupported Julia SDK facts")
    reviewed = json.loads((repo / "scripts/security/julia-notice-sources.json").read_text(encoding="utf-8"))
    if facts["juliaCommit"] != reviewed["juliaCommit"] or facts["juliaVersion"] != reviewed["juliaVersion"]:
        raise ValueError("Julia runtime requires a reviewed third-party source record")
    output = repo / "scripts/security/julia-notices"
    cache = repo / ".cache/julia-license-artifacts"
    if not output.resolve().is_relative_to(repo.resolve()) or not cache.resolve().is_relative_to(repo.resolve()):
        raise ValueError("Maintenance directories escape repository")
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
                notice_files, comparisons = extract_notices(archive, output, checksum, facts["libraries"])
            artifacts.append({"name": artifact["name"], "treeSha1": selected["git-tree-sha1"],
                "archiveUrl": url, "archiveSha256": checksum, "archiveBytes": archive.stat().st_size,
                "noticeFiles": notice_files, "libraryComparisons": comparisons,
                "status": "notices_collected" if notice_files else "no_notice_files_in_artifact"})
        result = {"name": component["name"], "uuid": component["uuid"], "version": component["version"],
            "metadataSha256": component["metadataSha256"], "artifacts": artifacts}
        count = sum(len(artifact.get("noticeFiles", [])) for artifact in artifacts)
        print(f"{component['name']}: {count} artifact notice files", flush=True)
        return result

    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
        components = list(pool.map(collect_component, facts["components"]))
    result = {"formatVersion": 1, "scope": "julia-sdk-reviewed-notice-sources",
        "capturedUtc": datetime.now(timezone.utc).isoformat(), "juliaVersion": facts["juliaVersion"],
        "juliaCommit": facts["juliaCommit"], "platform": facts["platform"],
        "runtimeThirdParty": runtime_notice, "components": components}
    index = output / "index.json"
    partial = index.with_suffix(".json.part")
    partial.write_text(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    os.replace(partial, index)
    print(f"Saved {len(components)} SDK component source records to {index.relative_to(repo)}", flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="enersy-julia-compute")
    parser.add_argument("--facts", type=Path, help="Previously captured SDK facts (offline discovery)")
    parser.add_argument("--jobs", type=int, choices=range(1, 5), default=3)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    facts = json.loads(args.facts.read_text(encoding="utf-8-sig")) if args.facts else get_facts(repo, args.image)
    refresh(repo, facts, args.jobs)


if __name__ == "__main__":
    main()
