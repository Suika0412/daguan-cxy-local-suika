# -*- coding: utf-8 -*-
"""把高数/概率题库切成标注任务分片，供子代理逐题标注。"""
import json, glob, os, io, re

def _require_dir(env_name, what):
    """按环境变量取目录并校验；缺失或非目录时显式退出，不回退旧路径。"""
    raw = (os.environ.get(env_name) or "").strip()
    if not raw:
        raise SystemExit(f"缺少{what}：请设置环境变量 {env_name}")
    path = os.path.abspath(raw)
    if not os.path.isdir(path):
        raise SystemExit(f"{what}不存在或不是目录：{env_name}={path}")
    return path

DATA = _require_dir("DAGUAN_DATA_DIR", "题库数据目录")
OUT = os.path.join(_require_dir("DAGUAN_TAGGER_OUT", "标注产物根目录"), "chunks")
os.makedirs(OUT, exist_ok=True)

ann = json.load(io.open(DATA + "/annotations.json", encoding="utf-8"))["annotations"]
luna_done = {qid for qid, a in ann.items() if a.get("luna_id")}

targets = []
for f in glob.glob(DATA + "/shards/*.json"):
    d = json.load(open(f, encoding="utf-8"))
    qs = d if isinstance(d, list) else d.get("questions", [])
    for q in qs:
        path = str(q.get("category_path") or "")
        if not (path.startswith("高等数学") or path.startswith("概率统计")):
            continue
        if str(q["id"]) in luna_done:
            continue
        stem = re.sub(r"\s+", " ", str(q.get("stem") or ""))[:500]
        sol = re.sub(r"\s+", " ", str((q.get("answer") or "") + " " + (q.get("explanation") or "")))[:700]
        targets.append({
            "id": str(q["id"]),
            "path": path,
            "source": str(q.get("source") or ""),
            "type": q.get("type"),
            "stem": stem,
            "sol": sol,
        })

print("to annotate:", len(targets))
CHUNK = 55
chunks = [targets[i:i + CHUNK] for i in range(0, len(targets), CHUNK)]
manifest = []
for i, ch in enumerate(chunks, 1):
    name = "c%03d.json" % i
    json.dump(ch, io.open(os.path.join(OUT, name), "w", encoding="utf-8"), ensure_ascii=False)
    manifest.append({"chunk": name, "count": len(ch), "subject": "概率统计" if ch[0]["path"].startswith("概率统计") else "高等数学"})
json.dump(manifest, io.open(os.path.join(OUT, "_manifest.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
subj = collections = {}
for m in manifest:
    subj[m["subject"]] = subj.get(m["subject"], 0) + m["count"]
print("chunks:", len(chunks), "| by subject:", subj)
