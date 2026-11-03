"""Build portable ZIPs with forward-slash entry names; exclude all local state."""
import hashlib
import json
import zipfile
import tarfile
import argparse
import shutil
from pathlib import Path

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / "package.json").read_text(encoding="utf-8"))
package_name = "software-factory-plato-" + manifest["version"]
parser = argparse.ArgumentParser()
parser.add_argument("--output-dir", help="Optional separate output directory if existing archives are open")
args = parser.parse_args()
dist = Path(args.output_dir).resolve() if args.output_dir else root / "dist"
dist.mkdir(parents=True, exist_ok=True)
if dist != root / "dist":
    shutil.copyfile(root / "dist" / (package_name + ".tgz"), dist / (package_name + ".tgz"))
with zipfile.ZipFile(dist / (package_name + ".zip"), "w", zipfile.ZIP_DEFLATED) as archive:
    with tarfile.open(dist / (package_name + ".tgz"), "r:gz") as package:
        for member in package.getmembers():
            if member.isfile():
                relative = member.name.removeprefix("package/")
                if relative.startswith("/") or ".." in relative.split("/"):
                    raise ValueError("Invalid package path: " + member.name)
                archive.writestr("software-factory-plato/" + relative, package.extractfile(member).read())

source_items = ["src", "scripts", "python", "vendor", "test-runtime-cache", "locale", "images",
                "package.json", "package-lock.json", "tsconfig.json", "cordis.patch.yml",
                "README.md", "icon.svg", "client.js",
                ".gitignore", "agent-registration.json"]
with zipfile.ZipFile(dist / (package_name + "-source.zip"), "w", zipfile.ZIP_DEFLATED) as archive:
    for item in source_items:
        entry = root / item
        for path in sorted(entry.rglob("*")) if entry.is_dir() else [entry]:
            if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc":
                archive.write(path, path.relative_to(root).as_posix())

for name in [package_name + ".zip", package_name + "-source.zip"]:
    with zipfile.ZipFile(dist / name) as archive:
        names = archive.namelist()
        assert any(p.endswith("agent-registration.json") for p in names)
        assert all("\\" not in p for p in names)
        assert not any(any(part in {".venv", "test-results", "data", "__pycache__", "LOCAL-SETUP.md", "config.yaml"} for part in p.split("/")) for p in names)
        assert archive.testzip() is None
        print(f"{name}: {len(names)} entries; registration present; no local state; CRC OK")

packages = [package_name + ".tgz", package_name + ".zip", package_name + "-source.zip"]
(dist / "SHA256SUMS.txt").write_text("".join(hashlib.sha256((dist / name).read_bytes()).hexdigest() + "  " + name + "\n" for name in packages), encoding="ascii")

checklist = ["PLATO 当前交付包逐文件清单（仅供检查，不是运行依赖）"]
for name in packages[1:]:
    with zipfile.ZipFile(dist / name) as archive:
        names = sorted(archive.namelist())
        checklist += ["", f"{name}（{len(names)} 个文件）"]
        checklist += ["[ ] " + path.removeprefix("software-factory-plato/") for path in names]
(dist / "交付文件清单.txt").write_text("\n".join(checklist) + "\n", encoding="utf-8")
