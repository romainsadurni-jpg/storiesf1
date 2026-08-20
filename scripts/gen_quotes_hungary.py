import json, re, subprocess, os

BASE = r"C:\Users\romai\Stories"
TEMPLATE = os.path.join(BASE, "templates", "quote-card.html")
OUT_DIR = os.path.join(BASE, "output", "hungary-fp1fp2")
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

os.makedirs(OUT_DIR, exist_ok=True)

QUOTES = [
    {
        "file": "leclerc",
        "context": "Ferrari signe le doublé sur les deux séances du vendredi à Budapest, Leclerc réagit :",
        "quote": "Notre performance globale a l'air plutôt bonne, c'est positif.",
        "name": "Charles Leclerc",
        "role": "Pilote — Ferrari",
        "isDriver": True,
        "team": "ferrari",
        "handle": "@SaD_F1",
        "portrait": "../assets/drivers/charles_leclerc/portrait.jpg",
        "background": "../assets/teams/ferrari/context_1.jpg",
    },
    {
        "file": "norris",
        "context": "McLaren peine en FP1 avant de repartir de l'avant en FP2 à Budapest, Norris réagit :",
        "quote": "Une journée compliquée, pas les deux séances les plus faciles pour nous.",
        "name": "Lando Norris",
        "role": "Pilote — McLaren",
        "isDriver": True,
        "team": "mclaren",
        "handle": "@SaD_F1",
        "portrait": "../assets/drivers/lando_norris/portrait.jpg",
        "background": "../assets/teams/mclaren/context_1.jpg",
    },
]

with open(TEMPLATE, encoding="utf-8") as f:
    template_src = f.read()

pattern = re.compile(r"const DATA = \{.*?\};", re.S)

for q in QUOTES:
    data = {k: v for k, v in q.items() if k != "file"}
    new_data_block = "const DATA = " + json.dumps(data, ensure_ascii=False) + ";"
    new_src = pattern.sub(new_data_block, template_src, count=1)

    tmp_path = os.path.join(BASE, "templates", f"_tmp_{q['file']}.html")
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(new_src)

    out_path = os.path.join(OUT_DIR, f"quote-{q['file']}-hungary.png")
    subprocess.run([
        CHROME, "--headless", "--disable-gpu", "--hide-scrollbars",
        "--window-size=1080,1920",
        f"--screenshot={out_path}",
        f"file:///{tmp_path.replace(os.sep, '/')}"
    ], capture_output=True)

    os.remove(tmp_path)
    print("done", q["file"], out_path)
