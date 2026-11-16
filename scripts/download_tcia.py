"""Download TCIA series listed in .tcia manifest files, using the public NBIA REST API.

Replaces the NBIA Data Retriever (no installation needed). Standard library only.

Usage (from the project root):
    python scripts/download_tcia.py                 # segmentations + matching CT scans (~8.5 GB)
    python scripts/download_tcia.py --only seg      # segmentations only (~1 GB), good first test
    python scripts/download_tcia.py --only ct       # matching CT scans only (~7.5 GB)

Output: data/dicom/<seg|ct>/<SeriesInstanceUID>/*.dcm
Safe to stop and re-run: finished series are skipped.

Data: RIDER Lung CT (https://doi.org/10.7937/k9/tcia.2015.u1x8a5nr) and
RIDER-LungCT-Seg (https://doi.org/10.7937/tcia.2020.jit9grk8), The Cancer Imaging Archive.
"""
import argparse
import shutil
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

API = "https://services.cancerimagingarchive.net/nbia-api/services/v1/getImage?SeriesInstanceUID="
ROOT = Path(__file__).resolve().parent.parent
META = ROOT / "data" / "tcia-metadata"
MANIFESTS = {
    "seg": META / "RIDER-Lung-CT-RTSTRUCTS-DICOM-SEGS-Leonard-Wee-Feb-10-2020.tcia",
    "ct": META / "RIDER-Lung-CT-Original-Scans-for-Leonard-Wee-Feb-10-2020-.tcia",
}


def series_uids(manifest: Path) -> list[str]:
    lines = manifest.read_text().splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith("ListOfSeriesToDownload"))
    return [line.strip() for line in lines[start + 1:] if line.strip()]


def download_series(uid: str, dest: Path, retries: int = 4) -> int:
    """Download and unpack one series. Returns the number of files written."""
    tmp_zip = dest.with_suffix(".zip.part")
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(API + uid, timeout=120) as resp, open(tmp_zip, "wb") as out:
                shutil.copyfileobj(resp, out, length=1024 * 1024)
            tmp_dir = dest.with_name(dest.name + ".part")
            if tmp_dir.exists():
                shutil.rmtree(tmp_dir)
            with zipfile.ZipFile(tmp_zip) as z:
                z.extractall(tmp_dir)
            tmp_zip.unlink()
            tmp_dir.rename(dest)  # only a fully unpacked series gets its final name
            return sum(1 for _ in dest.rglob("*") if _.is_file())
        except Exception as e:  # network hiccup or truncated zip: wait and retry
            print(f"    attempt {attempt}/{retries} failed: {e}")
            time.sleep(5 * attempt)
    raise RuntimeError(f"giving up on series {uid}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", choices=list(MANIFESTS), help="download just one of the two manifests")
    args = parser.parse_args()

    failed = []
    for name in ([args.only] if args.only else list(MANIFESTS)):
        uids = series_uids(MANIFESTS[name])
        out_dir = ROOT / "data" / "dicom" / name
        out_dir.mkdir(parents=True, exist_ok=True)
        print(f"== {name}: {len(uids)} series -> {out_dir}")
        for i, uid in enumerate(uids, 1):
            dest = out_dir / uid
            if dest.exists():
                print(f"[{i}/{len(uids)}] already there, skipping")
                continue
            print(f"[{i}/{len(uids)}] {uid}")
            t0 = time.time()
            try:
                n = download_series(uid, dest)
                print(f"    {n} files in {time.time() - t0:.0f}s")
            except RuntimeError as e:
                print(f"    FAILED: {e}")
                failed.append(uid)

    if failed:
        print(f"\n{len(failed)} series failed. Re-run the same command to retry them.")
        sys.exit(1)
    print("\nDone.")


if __name__ == "__main__":
    main()
