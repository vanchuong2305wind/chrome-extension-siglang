"""Prepare Android assets from the active VieSign release without modifying it."""
import argparse
from collections import Counter
import csv
import gzip
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
import unicodedata

PROJECT = Path(__file__).resolve().parents[1]
ASSETS = PROJECT / "android/app/src/main/assets"
PRIORITY = (
    "tôi|bạn|chào|xin chào|cảm ơn|xin lỗi|vâng|không|chưa|đừng|cần|muốn|"
    "giúp|cứu|đau|ở đâu|bao nhiêu|khi nào|hôm nay|ngày mai|tạm biệt|"
    "gia đình|mẹ|bố|con|ăn|uống|nước|nhà|trường học|bệnh viện|bác sĩ|"
    "điện thoại|đi|đến|về|làm|học|đợi|đúng|sai|có|được|xin"
).split("|")


def normalize(value):
    return " ".join(unicodedata.normalize("NFC", value).casefold().replace("_", " ").split())


def file_hash(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=PROJECT.parent / "signlangue-viesign-training-20261121")
    parser.add_argument("--limit", type=int, default=0, help="0 packages the complete runtime dictionary")
    args = parser.parse_args()
    if args.limit < 0:
        parser.error("--limit must be nonnegative")
    source = args.source.resolve()
    dataset = (source / json.loads((source / "data_v2/active_dataset.json").read_text())["directory"]).resolve()
    if not dataset.is_relative_to(source):
        raise ValueError("Active catalog is outside the source tree.")
    catalog = json.loads((dataset / "catalog.json").read_text(encoding="utf-8"))
    if catalog["dataset"] != "viesign":
        raise ValueError("Expected a VieSign catalog.")
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(source))
    from app.api.sign_lookup import SignDictionary

    runtime = SignDictionary()
    runtime.load()
    if runtime.data_dir.resolve() != dataset:
        raise ValueError("Runtime dictionary is using a different release.")
    labels = source / "models/camera/vsl224/labels.json"
    if file_hash(labels) != "b5cd803d59c2808e8dc7cc75aff1ac22480765ec81a30585947c7054fd72af9a":
        raise ValueError("Unexpected VSL224 label order or contents.")
    model_dir = ASSETS / "models"
    model_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(labels, model_dir / "labels.json")
    frequencies = Counter()
    manifests = sorted((source / "data_v2/VieSign10K").rglob("ISLR_447_all_rows.csv"))
    if manifests:
        with manifests[-1].open(encoding="utf-8-sig", newline="") as stream:
            frequencies.update(normalize(row["Meaning"].replace("_", " "))
                               for row in csv.DictReader(stream) if row["split"] == "train")
    priority = {word: index for index, word in enumerate(PRIORITY)}

    def rank(item):
        identifier, entry = item
        word = normalize(entry["vi"])
        return (priority.get(word, len(priority)), -frequencies[word],
                len(word.split()), -entry.get("score", 0), word, identifier)

    target = ASSETS / "signs"
    target.mkdir(parents=True, exist_ok=True)
    entries = {}
    skipped = []
    for identifier, entry in sorted(runtime.entries.items(), key=rank):
        clip = runtime.landmark_path(identifier)
        word = normalize(entry["vi"])
        if not re.fullmatch(r"vsl-[0-9a-f]{20}", identifier) or word in entries:
            raise ValueError(f"Invalid ID or duplicate word: {identifier} {word}")
        try:
            raw = clip.read_bytes()
            data = json.loads(raw)
            if not data["fps"] > 0 or not data["frames"] or not any(
                len(frame.get(hand) or []) == 21
                for frame in data["frames"] for hand in ("left_hand", "right_hand")
            ):
                raise ValueError("No usable hand frames")
        except (OSError, ValueError, KeyError) as error:
            skipped.append(f"{clip}: {error}")
            continue
        (target / f"{identifier}.json.gzip").write_bytes(gzip.compress(raw, compresslevel=6, mtime=0))
        entries[word] = identifier
        if args.limit and len(entries) == args.limit:
            break
    included = set(entries.values())
    for old in target.glob("vsl-*.json.gzip"):
        if old.name.removesuffix(".json.gzip") not in included:
            old.unlink()
    if skipped and not args.limit:
        raise ValueError("Runtime landmarks could not be packaged:\n" + "\n".join(skipped))
    aliases = {alias: meaning for alias, meaning in runtime._aliases.items()
               if meaning in entries and alias not in entries}
    (target / "dictionary.json").write_text(json.dumps(
        {"release": dataset.name, "entries": entries, "aliases": aliases}, ensure_ascii=False, indent=2
    ) + "\n", encoding="utf-8")
    chosen = PROJECT / "tool/selected-signs.txt"
    chosen.write_text("".join(f"{gloss}\t{word}\n" for word, gloss in entries.items()), encoding="utf-8")
    source_avatar = source / "app/frontend/public/models/avatar.vrm"
    avatar_dir = ASSETS / "avatar/models"
    avatar_dir.mkdir(parents=True, exist_ok=True)
    avatar = avatar_dir / source_avatar.name
    shutil.copyfile(source_avatar, avatar)
    digest = file_hash(avatar)
    assert digest == file_hash(source_avatar)
    notices = ASSETS / "notices"
    notices.mkdir(exist_ok=True)
    shutil.copyfile(source / "app/api/vsl_hiera/LICENSE", notices / "VSL224-LICENSE.txt")
    shutil.copyfile(source / "app/api/vsl_hiera/NOTICE.md", notices / "VSL224-NOTICE.md")
    print(f"{len(entries)} signs, {sum(p.stat().st_size for p in target.glob('*.gzip'))} compressed bytes")
    print(f"Avatar SHA-256: {digest}")
    if skipped:
        print("\n".join(skipped))


if __name__ == "__main__":
    main()

