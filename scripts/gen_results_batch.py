import json, re, subprocess, os

BASE = r"C:\Users\romai\Stories"
TEMPLATE = os.path.join(BASE, "templates", "results-card.html")
OUT_DIR = os.path.join(BASE, "output", "hungary-fp1fp2")
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

os.makedirs(OUT_DIR, exist_ok=True)

TEAMS = {
    "ferrari": {
        "fp1": [("Leclerc", "P1"), ("Hamilton", "P3")],
        "fp2": [("Hamilton", "P1"), ("Leclerc", "P2")],
        "quote": "Notre performance globale a l'air plutôt bonne, c'est positif.",
        "quoteBy": "Charles Leclerc",
    },
    "redbull": {
        "fp1": [("Verstappen", "P2"), ("Hadjar", "P4")],
        "fp2": [("Verstappen", "P4"), ("Hadjar", "P6")],
        "quote": "C'était un peu difficile de trouver un bon équilibre sur la voiture aujourd'hui.",
        "quoteBy": "Max Verstappen",
    },
    "mclaren": {
        "fp1": [("Norris", "P11"), ("Fornaroli", "P16")],
        "fp2": [("Norris", "P3"), ("Piastri", "P8")],
        "quote": "Une journée compliquée, pas les deux séances les plus faciles pour nous.",
        "quoteBy": "Lando Norris",
    },
    "mercedes": {
        "fp1": [("Russell", "P5"), ("Vesti", "P7")],
        "fp2": [("Russell", "P5"), ("Antonelli", "P13")],
        "quote": "Les Ferrari ont l'air très fortes, ça va être dur à battre.",
        "quoteBy": "George Russell",
    },
    "racingbulls": {
        "fp1": [("Lindblad", "P9"), ("Lawson", "P10")],
        "fp2": [("Lawson", "P7"), ("Lindblad", "P10")],
        "quote": "La voiture semble plutôt rapide, mais c'est un circuit très exigeant.",
        "quoteBy": "Liam Lawson",
    },
    "audi": {
        "fp1": [("Bortoleto", "P6"), ("Hulkenberg", "P8")],
        "fp2": [("Hulkenberg", "P9"), ("Bortoleto", "P11")],
        "quote": "On a récolté beaucoup de données utiles, même si les EL2 ont été un peu plus difficiles.",
        "quoteBy": "Gabriel Bortoleto",
    },
    "haas": {
        "fp1": [("Ocon", "P12"), ("Hirakawa", "P17")],
        "fp2": [("Ocon", "P12"), ("Bearman", "P15")],
        "quote": "C'est un bien meilleur vendredi que ce qu'on avait connu à Spa.",
        "quoteBy": "Esteban Ocon",
    },
    "alpine": {
        "fp1": [("Gasly", "P14"), ("Aron", "P19")],
        "fp2": [("Gasly", "P14"), ("Colapinto", "P21")],
        "quote": "C'est l'un des vendredis les plus compliqués qu'on ait connus cette année.",
        "quoteBy": "Pierre Gasly",
    },
    "astonmartin": {
        "fp1": [("Alonso", "P13"), ("Stroll", "P21")],
        "fp2": [("Alonso", "P19"), ("Stroll", "NT")],
        "quote": "C'était mieux aujourd'hui, à peu près ce qu'on attendait avec notre nouveau package.",
        "quoteBy": "Fernando Alonso",
    },
    "williams": {
        "fp1": [("Sainz", "P22"), ("Albon", "P15")],
        "fp2": [("Albon", "P16"), ("Sainz", "P17")],
        "quote": "Ce circuit expose nos principales faiblesses, on a du mal à trouver l'équilibre.",
        "quoteBy": "Carlos Sainz",
    },
    "cadillac": {
        "fp1": [("Perez", "P18"), ("Herta", "P20")],
        "fp2": [("Bottas", "P18"), ("Perez", "P20")],
        "quote": "On a bien progressé pendant la séance et on a réussi à calmer la voiture.",
        "quoteBy": "Valtteri Bottas",
    },
}

with open(TEMPLATE, encoding="utf-8") as f:
    template_src = f.read()

pattern = re.compile(r"const DATA = \{.*?\};", re.S)

for team, sessions in TEAMS.items():
    data = {
        "team": team,
        "handle": "@SaD_F1",
        "photo": f"../assets/teams/{team}/context_1.jpg",
        "sessions": [
            {"session": "FP1", "results": [{"name": n, "position": p} for n, p in sessions["fp1"]]},
            {"session": "FP2", "results": [{"name": n, "position": p} for n, p in sessions["fp2"]]},
        ],
        "quote": sessions["quote"],
        "quoteBy": sessions["quoteBy"],
    }
    new_data_block = "const DATA = " + json.dumps(data, ensure_ascii=False) + ";"
    new_src = pattern.sub(new_data_block, template_src, count=1)

    tmp_path = os.path.join(BASE, "templates", f"_tmp_{team}.html")
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(new_src)

    out_path = os.path.join(OUT_DIR, f"results-{team}-hungary-fp1fp2.png")
    subprocess.run([
        CHROME, "--headless", "--disable-gpu", "--hide-scrollbars",
        "--window-size=1080,1920",
        f"--screenshot={out_path}",
        f"file:///{tmp_path.replace(os.sep, '/')}"
    ], capture_output=True)

    os.remove(tmp_path)
    print("done", team, out_path)
