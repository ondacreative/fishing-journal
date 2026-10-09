# Fishing journal

Mark's fishing log for the River Dove. A single web page, served by GitHub Pages.

- `index.html`: the journal.
- `conditions.js`: river and weather for each catch, and the live "Right now" card.
  Data from the Environment Agency (Marston on Dove gauge) and Open-Meteo.
- `store.js`: saves to `data/` through the GitHub API, with a key kept on the phone.
- `data/catches.json`, `data/trips.json`: the journal itself. `trips` are sessions.
- `data/normals.json`: long-term averages for the barbel rating. Built by `make_normals.py`
  in the local project folder.
- `photos/`: catch photos.
