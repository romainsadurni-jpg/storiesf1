# Automation — veille FIA → digest Telegram

Instructions pour l'agent cloud planifié (routine "FIA press conference watch").
Ce fichier est la source de vérité ; le prompt de la routine ne fait que
pointer ici pour rester court et éditable sans recréer la routine.

## But

Toutes les heures, détecter les nouvelles conférences de presse FIA publiées
pour le Grand Prix en cours, en extraire les meilleures citations, et envoyer
un digest texte en français sur Telegram pour que l'utilisateur choisisse
lesquelles transformer en story visuelle (ça, c'est fait plus tard, en local,
avec `scripts/gen_stories_from_transcript.ts` — pas ici, pas de rendu Chrome
dans le cloud).

## Étapes

1. `npm install` (une fois, dépôt frais à chaque run).
2. `npx tsx scripts/cloud-digest.ts list` — renvoie du JSON :
   `{ event, newTranscripts: [{ title, url, publishedAt, qas: [...] }] }`.
   Chaque `qa` a déjà été filtrée sur les intervenants connus (pilotes/team
   principals du manifest) — pas besoin de refiltrer. Si `newTranscripts` est
   vide, **ne rien envoyer, s'arrêter là** (pas de bruit sur Telegram).
3. Pour chaque transcript de `newTranscripts`, condense chaque `qa` en
   français toi-même (tu es déjà un LLM, pas besoin d'appeler une API
   externe) en suivant EXACTEMENT ces règles (reprises de
   `src/transcript-synthesis.ts`, le pipeline local) :

   - D'abord juge si la paire question/réponse est "réelle" : écarte les
     relances de modérateur, remerciements, transitions ("Okay merci, on
     passe à..."), blagues sans substance, ou réponses du style "oui/non/ça
     n'a pas d'importance" sans développement. Garde tout ce qui porte sur un
     vrai sujet (course, stratégie, avenir, polémique, ressenti, décision...)
     avec une réponse qui développe une idée, même courte.
   - `context` : une phrase courte (≈80-110 caractères) qui pose la
     situation à partir de la QUESTION, façon légende de story sportive —
     jamais "le journaliste demande...". Termine par ":". Exemple :
     "Sur son avenir chez Red Bull, Verstappen botte en touche :".
   - `quote` : citation condensée en français fluide, fidèle au sens,
     environ 100-220 caractères. Ne coupe pas à la première phrase venue :
     garde le détail concret qui donne du poids (chiffre, nom cité,
     comparaison, raison invoquée, nuance). Sentence case, jamais de
     majuscules, pas de guillemets autour, toujours en français (jamais un
     mot d'anglais qui traîne).
   - Si une réponse développe plusieurs idées distinctes, tu peux produire
     plusieurs cartes (une par idée) plutôt qu'une seule qui essaie de tout
     dire.

4. Formate un message Telegram par transcript (Markdown), structuré ainsi :

   ```
   🏁 *<Titre du transcript>*

   1. *<Nom> — <Team>*
      <context>
      « <quote> »

   2. *<Nom> — <Team>*
      ...

   <url du transcript>
   ```

   Numérote en continu à partir de 1 pour que l'utilisateur puisse répondre
   plus tard "je veux la 3 et la 7". Si le message dépasse ~3500 caractères,
   coupe en plusieurs messages Telegram (même transcript, `(1/2)` `(2/2)`
   dans le titre) plutôt que de tronquer le contenu.

5. Envoie via l'API Telegram : `POST https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/sendMessage`
   avec `chat_id`, `text`, `parse_mode=Markdown`. **Important** : envoie un
   corps JSON (`Content-Type: application/json`), pas de form-encoding —
   `curl -d "text=..."` casse l'UTF-8 sur les accents français et Telegram
   répond alors `400 strings must be encoded in UTF-8`. Exemple fiable :
   `curl -s -X POST "https://api.telegram.org/bot<TOKEN>/sendMessage" -H "Content-Type: application/json" -d @payload.json`
   où `payload.json` est écrit sur disque (pas construit inline dans la
   commande shell) pour éviter tout problème d'échappement.
   Le token et le chat_id sont fournis dans le prompt de la routine — ne pas
   les logger ni les afficher en clair dans les commits.

6. Une fois l'envoi Telegram confirmé (HTTP 200 `ok: true`) pour un
   transcript, marque-le vu : `npx tsx scripts/cloud-digest.ts mark-seen <url>`.
   Si un transcript n'a produit AUCUNE citation exploitable (toutes les
   paires jugées "pas réelles"), marque-le vu quand même — inutile de le
   re-vérifier chaque heure. Ne marque PAS vu un transcript si le fetch/parse
   a échoué (erreur réseau, page cassée) — il sera retenté au prochain
   passage.

7. `git add data/telegram-seen.json && git commit -m "chore: mark transcripts as seen" && git push`
   pour que l'état survive au prochain run (chaque run cloud part d'un
   checkout frais du dépôt).

## Erreurs / cas limites

- Si `determineCurrentEventName` ne trouve aucun Grand Prix (hors-saison),
  `event` sera `null` et `newTranscripts` vide — c'est normal, ne rien faire.
- Si l'appel Telegram échoue (token invalide, chat_id faux, réseau), NE PAS
  marquer vu, logguer l'erreur dans la session, s'arrêter sans planter le
  commit (pas de push si rien n'a changé).
