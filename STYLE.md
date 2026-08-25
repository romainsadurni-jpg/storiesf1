# Stories F1 — Guide de style

Déclinaison du langage visuel `f1-thumbnail-style` (miniatures YouTube) pour le format
story verticale. Objectif : générer des posters 100% en code (HTML/CSS), sans passer
par un modèle de génération d'image, pour garder un rendu cohérent d'une story à l'autre.

## Format technique

- **Dimensions** : 1080×1920 px (ratio 9:16), toujours.
- **Sortie** : HTML/CSS autonome → export PNG (pas de génération d'image IA).
- **Zones de sécurité Instagram/TikTok** : ne rien placer d'important dans les
  ~250px du haut (barre de compte/heure) et les ~250px du bas (barre de réponse/CTA).
  Le fond (dégradé, vignette) peut aller bord à bord, le contenu texte reste dans
  la zone centrale ~1080×1420.

## Bibliothèque d'assets (`assets/`)

Les templates s'appuient sur une bibliothèque de photos réelles fournies par
l'utilisateur (pas de génération IA de visages), organisée par catégorie :

```
assets/
  principals/<slug>/portrait.jpg   — team principals (un dossier par personne,
  drivers/<slug>/portrait.jpg      — pilotes                peut accueillir
  teams/<slug>/logo.png            — logos/couleurs écurie   d'autres photos:
  orgs/<slug>/logo.png             — organisations hors écurie (FIA...)   action.jpg, etc.)
  context/<slug>.jpg   — plans génériques (grille de départ, podium,
                          paddock, stand, pluie, safety car...)
  manifest.json — index mot-clé → fichier (voir ce fichier pour le format)
```

`orgs/<slug>/logo.png` suit la même logique que `teams/` mais pour un sujet
institutionnel sans écurie propre (FIA, diffuseurs...) : pas d'entrée
`TEAM_COLORS` dédiée dans `quote-card.html`, la carte retombe sur la couleur
`generic` (bleu foncé `#12213A`, déjà la couleur "FIA / générique 2026" du
tableau ci-dessous) — seul le logo change. Liste des orgs reconnues :
`src/orgs.ts`.

Roster 2026 (11 écuries, 22 pilotes, 11 team principals) pré-créé en dossiers
vides le 2026-08-18, vérifié par recherche web. Les dossiers `context/`
restent créés au fil de l'eau, un plan à la fois selon les besoins des tweets.

**Logos écurie** : `assets/teams/<slug>/logo.png` (ou `.svg` pour Mercedes) sont
des **hardlinks NTFS** vers la bibliothèque partagée
`C:\Users\romai\Hyperframe\registry-vertical\assets\logos\` (projet vidéo
Hyperframe) — même fichier physique, pas une copie. Un logo propre, sans
sponsor, par écurie (exception : Racing Bulls reste en lockup sponsor complet
Visa/Cash App, seule version disponible, actée comme définitive côté
Hyperframe). Si un logo manque ou doit être mis à jour, le faire dans la
bibliothèque Hyperframe (voir son `manifest.json`/`README.md`) puis relier ici.

Workflow quand un tweet arrive :
1. Identifier la/les personne(s) citée(s) et le contexte évoqué (ex: "grille
   de départ" pour une remarque sur la procédure de départ).
2. Chercher ces clés dans `assets/manifest.json` (aliases inclus).
3. Si trouvé → utiliser le chemin du fichier dans le template.
4. Si absent → demander à l'utilisateur la photo correspondante (nom de
   fichier attendu, catégorie), l'ajouter au manifeste une fois fournie.

Les templates ont un **fallback gracieux** : si un fichier référencé n'existe
pas encore, le rendu affiche un placeholder neutre (cercle gris avec
initiales pour un portrait, dégradé uni pour un fond de contexte) plutôt que
de casser — utile pour prévisualiser la mise en page avant d'avoir l'asset.

## Structures disponibles

### Structure Q — "Quote card contextuelle" (citation + portrait + fond)
1. Fond : photo de contexte (`assets/context/...`) plein cadre, assombrie par
   un dégradé couleur écurie → noir + vignette, pour la lisibilité du texte.
2. Badge en haut à gauche : nom du compte/chaîne, petit, discret.
3. Portrait circulaire de la personne citée (`assets/principals/...` ou
   `assets/drivers/...`), cerclé d'un anneau couleur écurie.
4. Nom (majuscules, bold) + fonction (plus petit) directement sous le portrait.
5. Citation en gros texte extra-bold, **sentence case** (pas de majuscules —
   c'est une parole rapportée, pas un titre choc), centrée, entre guillemets.
6. Watermark bas de page : petit, discret.

Variante sans photo dispo : le fond retombe sur un dégradé uni couleur écurie
(comme avant) et le portrait sur un cercle initiales — rien ne casse tant que
les assets ne sont pas fournis.

### Structure P — "Penalty card" (pénalité/sanction pilote) — `templates/penalty-card.html`
Style validé, voir mémoire `feedback_penalty_card_style_validated`. Carte contenue
(coins arrondis, marge, pas plein cadre) : photo tête+épaules sur fond studio
blanc/gris texturé (grain subtil, pas un dégradé plat), titre choc, bandeau motif
couleur écurie (dégradé foncé→clair→foncé, une seule ligne, coins arrondis),
logo écurie seul en haut à droite (pas de sponsor). Police Titillium Web
auto-hébergée (voir Typographie).

### Structure R — "Results card" (résultats de séance FP1/FP2/FP3/Qualif/Course) — `templates/results-card.html`
Fond plein cadre couleur écurie avec motif logo répété en filigrane (tuile SVG
`<pattern>`, PAS de `mask-image` CSS — voir note technique ci-dessous). Titre
"{SESSION} RESULTS" en effet écho (texte plein + contour décalé). Logo écurie
en haut à droite. Grande photo carrée arrondie (action piste). Bloc résultats
(fond couleur écurie plus sombre, coins arrondis) qui chevauche le coin
bas-droit de la photo : nom pilote + position en gros, jusqu'à 2 pilotes
empilés séparés par un trait.

**Note technique — `mask-image` CSS non fiable en rendu headless** : dans cet
environnement, appliquer `mask-image`/`-webkit-mask-image` sur un fichier local
via JS (`style.maskImage`, `setProperty`, ou même un `<style>` injecté
dynamiquement) ne charge pas l'image à temps pour la capture — fond vide. Pour
un motif répété (logo en filigrane, texture), utiliser un `<svg>` avec
`<pattern>` + `<image href="...">` à la place : même mécanisme de chargement
fiable que les `<img>` classiques.

## Typographie

- **Structure Q (déclaration)** : `'Arial Black', 'Helvetica Neue', Arial, sans-serif`
  système, `font-weight: 900` — sentence case pour les citations, jamais tout en majuscules.
- **Structures P et R (pénalité, résultats)** : **Titillium Web** (police officielle F1),
  auto-hébergée en local (`assets/fonts/titillium-700.woff2`, `-900.woff2`) via
  `@font-face` — ne jamais utiliser un `<link>` Google Fonts en direct, voir mémoire
  `feedback_self_host_fonts` (casse le rendu headless dans cet environnement, et un
  fallback système type Arial Black se voit — reproche "bas de gamme" reçu une fois).
- Titres choc : MAJUSCULES systématiques, 2-4 mots max par ligne.
- Toujours un contraste fort texte/fond (blanc sur fond sombre, jamais de gris moyen).

## Palette par écurie

Identique à `f1-thumbnail-style` :

| Écurie | Couleur | Code |
|---|---|---|
| Ferrari | Rouge vif | #E8002D |
| Red Bull | Bleu marine | #1E3A8A |
| McLaren | Orange | #FF8000 |
| Mercedes | Vert-cyan | #00A19C |
| Aston Martin | Vert British Racing | #00594F |
| Alpine | Bleu marine/rose | #0090D0 |
| Cadillac / écuries US | Noir/argent | #0A0A0A |
| FIA / générique 2026 | Bleu foncé | #12213A |

## Workflow de génération

1. Recevoir le texte brut (tweet/news) + identifier qui parle et pour quelle écurie.
2. Choisir la structure (Q = citation, N = annonce/résultat/rumeur).
3. Remplir l'objet `DATA` en tête du template HTML correspondant
   (`templates/quote-card.html` pour Structure Q).
4. Ouvrir/rendre le HTML à 1080×1920 et exporter en PNG.
5. Vérifier la lisibilité en réduisant mentalement à la taille d'une vignette
   de story dans le fil (bandeau haut de l'app) : le texte principal doit
   rester lisible.

## Statut

- [x] Structure Q — quote card (`templates/quote-card.html`)
- [x] Structure P — penalty card (`templates/penalty-card.html`)
- [x] Structure R — results card (`templates/results-card.html`)
- [ ] Pipeline de capture Discord/Telegram → génération automatique
