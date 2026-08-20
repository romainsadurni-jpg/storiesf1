# Driver Photo Download Log

Generated 2026-08-19. Photos for the 22 F1 driver folders under `assets/drivers/`, per the roster in `assets/manifest.json`.

## Session note

The original download agent ran across a session that was interrupted mid-task (background process stopped without a completion report). On resuming, 19 of 22 driver folders were found already populated with 5 files each — this work was verified directly on disk (file type + size checked for every file), but the per-file source URLs from that original run were not preserved anywhere retrievable, so they are not listed individually below. All 19 drivers: lando_norris, oscar_piastri, lewis_hamilton, charles_leclerc, max_verstappen, isack_hadjar, george_russell, kimi_antonelli, fernando_alonso, lance_stroll, alexander_albon, carlos_sainz, nico_hulkenberg, gabriel_bortoleto, pierre_gasly, franco_colapinto, esteban_ocon, oliver_bearman, liam_lawson — sourced from a mix of Wikimedia Commons, official team sites, and press sites, following the same license-note convention used in `assets/principals/_download_log.md` and `assets/teams/_download_log.md` (Commons = check license per file; official/press site = not verified, do not repost publicly without checking).

Two corrupted leftover files (Wikimedia HTTP 429 error pages saved with a `.jpg` extension) were found and deleted during verification: `arvid_lindblad/portrait.jpg` (folder was otherwise empty) and `george_russell/portrait_3.jpg` (folder still had 4 other valid files). A stray `test_isack.jpg` debug file sitting directly in `assets/drivers/` (not in any driver folder) was also deleted.

## Gaps filled directly (this session)

| Driver | File | Source URL | Orientation | License note |
|---|---|---|---|---|
| Valtteri Bottas | portrait.jpg | https://commons.wikimedia.org/wiki/File:Valtteri_Bottas_at_the_2026_Adelaide_Motorsport_Festival_(028A7556).jpg | vertical (1280×1920) | Wikimedia Commons — check file page for exact CC license before public repost |
| Arvid Lindblad | portrait.jpg | https://commons.wikimedia.org/wiki/File:Arvid_Lindblad_at_the_Red_Bull_Fan_Zone_–_Crown_Riverwalk,_Melbourne_(028A7869).jpg | vertical (3590×5385) | Wikimedia Commons, CC BY-SA 4.0 |
| Sergio Pérez | portrait.jpg | cropped from https://media.formula1.com/.../2026cadillacserper01right.webp (official F1.com driver portrait) | headshot crop, square-ish (850×900) | source: official F1.com — license not verified, do not repost publicly without checking. Cropped locally from a full-body transparent cutout (kept as `portrait_2.webp`) to get a usable head crop for the circular template. |

**Coverage status: 22/22 drivers now have at least 1 valid portrait.** Bottas, Lindblad, and Pérez have only 1 photo each (vs. up to 5 for the other 19) — a follow-up pass could add more variety for these three if needed.

## Method note on the Pérez crop

`media.formula1.com` driver portraits are extreme tall transparent cutouts (e.g. 1920×5519) meant for a specific site layout, not a usable circular-crop source as-is — the face only occupies the top ~15% of the frame. Cropped locally with Pillow (`box = (500, 0, 1350, 900)` on the original) to isolate the head/shoulders. If more drivers turn out to have this same F1.com cutout format, the same crop approach applies (check the image dimensions before assuming a plain center-crop will hit the face).
