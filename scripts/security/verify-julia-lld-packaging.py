"""Reproduce reviewed Julia 1.13.2 Linux LLD packaging operations.

Maintenance only: Python orchestrates Docker; no compiler is needed on the host.
This does not modify the SDK or authorize a new artifact-platform binding.
Foreign SDK images are read without execution; the patchelf builder is amd64.
"""

import argparse
import hashlib
import importlib.util
import json
import re
import subprocess
import tarfile
import tempfile
import tomllib
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("julia_notices", Path(__file__).with_name("update-julia-notices.py"))
NOTICES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(NOTICES)

VERSION = "1.13.2"
COMMIT = "45b6d15e34bbd2003a31acce0b1847b63dad029c"
PLATFORM = "x86_64-linux-gnu-libgfortran5-cxx11-libstdcxx30-julia_version+1.13.2"
UUID = "d55e3150-da41-5e91-b323-ecfd1eec6109"
METADATA_SHA = "dff41faf5c61448a636fbb845f240903475aba844a0bcb8daf7a4516e01916b8"
ARCHIVE_SHA = "96052dfa6bfbc41930fac40b163fa47558819f7ba8ab2feed962f7e8f0743081"
ARCHIVE_URL = "https://github.com/JuliaBinaryWrappers/LLD_jll.jl/releases/download/LLD-v20.1.8+2/LLD.v20.1.8.x86_64-linux-gnu-cxx11-llvm_version+20.tar.gz"
SOURCE_SHA = "e77fae23ddbc6dfcf2a1a79ff8cbf61138ec95ed7ae95bb493c30a85bd2aedfc"
SDK_SHA = "ea38ae21454bd2fe3b6585bdf7ceb561f8dbdf0ee7369f3559d462cc4034dd58"
SDK_FILE = "libexec/julia/lld"
TOOL_URL = "https://github.com/NixOS/patchelf/releases/download/0.17.2/patchelf-0.17.2.tar.bz2"
TOOL_SHA512 = "8277adf95513f88fb190536a38bdfdf438a4cc7685d8a130bdffbe064441f0f25095b6c83bbb190133e1a138963776d15b46c247dd2f1a073a1bfe1d1dbdd503"
RPATH = "$ORIGIN/../../lib/julia"
ARM64_PLATFORM = "aarch64-linux-gnu-libgfortran5-cxx11-libstdcxx30-julia_version+1.13.2"


def reviewed_target(platform=PLATFORM):
    if platform == PLATFORM:
        return {"platform": PLATFORM, "arch": "x86_64", "archiveSha256": ARCHIVE_SHA, "archiveUrl": ARCHIVE_URL,
            "sourceSha256": SOURCE_SHA, "sourceBytes": 7511664, "sdkSha256": SDK_SHA, "sdkBytes": 7515760}
    if platform == ARM64_PLATFORM:
        # Compared with metadata and product bytes captured by the native ARM64
        # SDK CI job for commit 6b7123f; never inherit the amd64 byte identities.
        return {"platform": ARM64_PLATFORM, "arch": "aarch64",
            "archiveSha256": "18c398b99e7c5f06fbebca4f0dad38e16a9e2fb948f351f03220746fdcfd45fc",
            "archiveUrl": "https://github.com/JuliaBinaryWrappers/LLD_jll.jl/releases/download/LLD-v20.1.8+2/LLD.v20.1.8.aarch64-linux-gnu-cxx11-llvm_version+20.tar.gz",
            "sourceSha256": "87313d2f984e19add754d22ea7bb08b8aea357b9202a304feb6bc8b12a3790d5", "sourceBytes": 7114584,
            "sdkSha256": "fa520989300f487e34b57c3f6672b1aa4d4c10cbc71353de291f28a111f82f21", "sdkBytes": 7180120}
    raise ValueError("LLD packaging proof requires an exact reviewed Julia Linux runtime")

# Fixed commands, no strings or shell fragments from facts, archives or CLI args.
BUILD = """set -eu
test "$(uname -m)" = x86_64
mkdir /tmp/lld-patchelf-proof
cd /tmp/lld-patchelf-proof
tar -xjf /inputs/patchelf.tar.bz2 --strip-components=1
./configure > /output/configure.log 2>&1
make -j2 > /output/build.log 2>&1
test "$(./src/patchelf --version)" = 'patchelf 0.17.2'
cp /inputs/lld /output/lld
./src/patchelf --set-rpath '$ORIGIN/../../lib/julia' /output/lld
"""


def validate_facts(facts):
    target = reviewed_target(facts.get("platform"))
    if (facts.get("formatVersion"), facts.get("scope"), facts.get("juliaVersion"),
            facts.get("juliaCommit"), facts.get("platform")) != (
            1, "julia-sdk-notice-facts", VERSION, COMMIT, target["platform"]):
        raise ValueError("LLD packaging proof requires the exact reviewed Julia Linux runtime")
    components = [row for row in facts["components"] if row["uuid"] == UUID]
    if len(components) != 1 or (components[0]["name"], components[0]["version"], components[0]["metadataSha256"]) != (
            "LLD_jll", "20.1.8+2", METADATA_SHA):
        raise ValueError("LLD SDK metadata identity changed")
    products = [row for row in facts.get("executables", []) if row["file"] == SDK_FILE]
    if len(products) != 1 or (products[0]["sha256"], products[0]["bytes"], products[0]["component"]) != (
            target["sdkSha256"], target["sdkBytes"], "LLD_jll"):
        raise ValueError("LLD SDK executable identity changed")
    return target


def validate_metadata(data, target=None):
    target = reviewed_target() if target is None else target
    if hashlib.sha256(data).hexdigest() != METADATA_SHA:
        raise ValueError("LLD artifact metadata differs from the SDK facts")
    rows = tomllib.loads(data.decode("utf-8"))["LLD"]
    matches = [row for row in rows if (row.get("arch"), row.get("os"), row.get("libc"),
        row.get("cxxstring_abi"), row.get("llvm_version"), row.get("sanitize")) == (
        target["arch"], "linux", "glibc", "cxx11", "20", None)]
    if len(matches) != 1 or {"url": target["archiveUrl"], "sha256": target["archiveSha256"]} not in matches[0]["download"]:
        raise ValueError("Ordinary LLD archive is not declared by this SDK")


def artifact_product(archive, target=None):
    target = reviewed_target() if target is None else target
    if NOTICES.file_hash(archive) != target["archiveSha256"]:
        raise ValueError("LLD archive checksum changed")
    with tarfile.open(archive, "r:gz") as stream:
        matches = [member for member in stream if member.name == "tools/lld"]
        if len(matches) != 1 or not matches[0].isfile() or matches[0].size != target["sourceBytes"]:
            raise ValueError("LLD archive product is missing, duplicated, linked or resized")
        with stream.extractfile(matches[0]) as source:
            data = source.read(target["sourceBytes"] + 1)
    if len(data) != target["sourceBytes"] or hashlib.sha256(data).hexdigest() != target["sourceSha256"]:
        raise ValueError("LLD artifact product checksum changed")
    return data


def verify_output(file, target=None):
    target = reviewed_target() if target is None else target
    if not file.is_file() or file.is_symlink() or file.stat().st_size != target["sdkBytes"] or NOTICES.file_hash(file) != target["sdkSha256"]:
        raise ValueError("Repackaged LLD is not byte-identical to the reviewed SDK executable")
    return {
        "formatVersion": 1, "scope": "julia-lld-repackaging-verification",
        "juliaVersion": VERSION, "juliaCommit": COMMIT, "platform": target["platform"],
        "componentUUID": UUID, "metadataSha256": METADATA_SHA,
        "archiveUrl": target["archiveUrl"], "archiveSha256": target["archiveSha256"],
        "artifactFile": "tools/lld", "artifactSha256": target["sourceSha256"],
        "sdkFile": SDK_FILE, "sdkSha256": target["sdkSha256"], "sdkBytes": target["sdkBytes"],
        "tool": {"version": "0.17.2", "sourceUrl": TOOL_URL, "sourceSha512": TOOL_SHA512},
        "operation": ["patchelf", "--set-rpath", RPATH],
        "reproducedSha256": NOTICES.file_hash(file), "reproducedBytes": file.stat().st_size,
        "sameBytesAfterRepackaging": True,
    }


def mount(file, target, readonly=True):
    file = file.resolve()
    if "," in str(file):
        raise ValueError("Docker proof mount paths must not contain commas")
    return f"type=bind,source={file},target={target}" + (",readonly" if readonly else "")


def image_id(image):
    identity = subprocess.run(["docker", "image", "inspect", "--format", "{{.Id}}", image],
        check=True, capture_output=True, text=True).stdout.strip()
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", identity):
        raise ValueError("Docker did not return a content-addressed image identity")
    return identity


def copy_sdk_inputs(image, workspace):
    """Read SDK files from a stopped container, including a foreign architecture.

    No program from the SDK image runs. Copy only the two fixed proof inputs;
    linked or non-regular products are not accepted as source evidence.
    """
    container = subprocess.run(["docker", "create", "--network", "none", "--entrypoint", "/bin/false", image],
        check=True, capture_output=True, text=True).stdout.strip()
    if not re.fullmatch(r"[a-f0-9]{64}", container):
        raise ValueError("Docker did not return an exact proof container identity")
    metadata = workspace / "StdlibArtifacts.toml"
    product = workspace / "sdk-lld"
    try:
        for source, target in (("share/julia/stdlib/v1.13/LLD_jll/StdlibArtifacts.toml", metadata), (SDK_FILE, product)):
            subprocess.run(["docker", "cp", f"{container}:/usr/local/julia/{source}", str(target)],
                check=True, capture_output=True)
            if not target.is_file() or target.is_symlink():
                raise ValueError("SDK proof input is not a regular copied file")
        return metadata.read_bytes(), product
    finally:
        subprocess.run(["docker", "rm", container], check=True, capture_output=True)


def run(repo, sdk_image, builder_image, facts_file=None):
    sdk_image, builder_image = image_id(sdk_image), image_id(builder_image)
    facts = json.loads(facts_file.read_text(encoding="utf-8-sig")) if facts_file else NOTICES.get_facts(repo, sdk_image)
    target = validate_facts(facts)
    cache = repo / ".cache/julia-license-artifacts"
    if not cache.resolve().is_relative_to(repo.resolve()):
        raise ValueError("LLD proof cache escapes repository")
    cache.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="lld-proof-", dir=cache) as temporary:
        workspace = Path(temporary)
        metadata, sdk_product = copy_sdk_inputs(sdk_image, workspace)
        validate_metadata(metadata, target)
        if sdk_product.stat().st_size != target["sdkBytes"] or NOTICES.file_hash(sdk_product) != target["sdkSha256"]:
            raise ValueError("Copied SDK executable differs from the reviewed facts")
        archive = NOTICES.download(target["archiveUrl"], cache / (target["archiveSha256"] + ".tar.gz"), target["archiveSha256"])
        product = artifact_product(archive, target)
        tool = NOTICES.download(TOOL_URL, cache / "patchelf-0.17.2.tar.bz2")
        if hashlib.sha512(tool.read_bytes()).hexdigest() != TOOL_SHA512:
            raise ValueError("Patchelf source checksum differs from the Julia build recipe")
        original = workspace / "original-lld"
        original.write_bytes(product)
        output = workspace / "output"
        output.mkdir()
        result = subprocess.run(["docker", "run", "--rm", "--network", "none", "--cpus", "2", "--memory", "1g",
            "--mount", mount(tool, "/inputs/patchelf.tar.bz2"), "--mount", mount(original, "/inputs/lld"),
            "--mount", mount(output, "/output", readonly=False), "--entrypoint", "timeout", builder_image, "300", "sh", "-c", BUILD])
        if result.returncode:
            logs = "\n".join(file.read_text(errors="replace")[-4000:] for file in (output / "configure.log", output / "build.log") if file.is_file())
            raise RuntimeError(f"LLD packaging reproduction failed (Docker exit {result.returncode}):\n{logs}")
        report = verify_output(output / "lld", target)
        report.update(sdkImageId=sdk_image, builderImageId=builder_image)
        return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk-image", default="enersy-julia-compute")
    parser.add_argument("--builder-image", default="enersy-numerics-check")
    parser.add_argument("--facts", type=Path, help="Previously captured facts; SDK files are still checked against the inspected image")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    print(json.dumps(run(repo, args.sdk_image, args.builder_image, args.facts), indent=2))


if __name__ == "__main__":
    main()
