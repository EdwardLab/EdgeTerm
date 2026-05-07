# EdgeTerm

EdgeTerm is a browser-native runtime platform built around Pyodide, WASM, and local-first workspaces.

This repo now supports two editions built from the same frontend runtime:

- `Offline Edition`: pure static files, no backend, no cloud UI, no API calls
- `Cloud Edition`: the same frontend plus a Flask backend for auth, snapshots, sharing, and admin control

The backend never executes user code. User code still runs entirely in the browser runtime.

## Repo layout

```text
frontend/
  index.html
  src/
    core/
    cloud/
    ui/
    features/

backend/
  app.py
  models.py
  auth.py
  admin.py
  snapshots.py
  shares.py
  templates/
  static/
```

## Build rootfs

Run `buildrootfs.bat` after changing files in `rootfs/` to regenerate `rootfs.zip`.

## Install frontend build deps

```bash
npm install
```

## Build editions

Offline build:

```bash
npm run build:offline
```

Cloud build:

```bash
npm run build:cloud
```

Or use the provided `Makefile` targets:

```bash
make offline
make cloud
make clean
make run
```

## Offline Edition

Offline Edition is emitted to `build/` by `npm run build:offline` and to `dist-offline/` by `make offline`.

Properties:

- pure static runtime
- no login/register UI
- no cloud sync UI
- no share/admin UI
- no cloud API calls

You can serve it with any static server, or open `build/index.html` directly where browser restrictions allow.

## Cloud Edition

Cloud Edition uses Flask and keeps the runtime in the browser.

Install Flask:

```bash
python -m pip install -r backend/requirements.txt
```

Run locally:

```bash
cd backend
python app.py --host 127.0.0.1 --port 8082
```

Current local preview:

- [http://127.0.0.1:8082/](http://127.0.0.1:8082/)
- [http://127.0.0.1:8082/admin](http://127.0.0.1:8082/admin)

Cloud responsibilities:

- `POST /api/register`
- `POST /api/login`
- `POST /api/logout`
- `GET /api/me`
- `POST /api/snapshot/upload`
- `GET /api/snapshot/list`
- `GET /api/snapshot/download/<id>`
- `DELETE /api/snapshot/<id>`
- `POST /api/share/create`
- `GET /api/share/resolve`
- `GET /api/share/<id>`
- `POST /api/share/update/<id>`
- `POST /api/share/revoke/<id>`
- `POST /api/share/writeback/<id>`
- `GET /api/admin/users`
- `POST /api/admin/users`
- `POST /api/admin/users/<id>`
- `DELETE /api/admin/users/<id>`
- `GET /api/admin/storage`
- `GET /api/admin/shares`
- `GET /api/admin/tiers`
- `POST /api/admin/tiers`
- `DELETE /api/admin/tiers/<id>`
- `POST /api/admin/settings`

## Cloud storage backends

Cloud Edition now supports:

- MySQL for metadata
- local blob storage for rootfs snapshot zip files

Metadata stored in MySQL:

- users
- sessions
- snapshots metadata
- shares
- share allowed-user lists
- tiers
- platform settings

Blob files stored on disk:

- `backend/.edgeterm-cloud/blobs/` by default

Cloud Edition now requires MySQL. If MySQL is not configured, the backend will fail to start instead of silently falling back to a local JSON store.

### MySQL configuration

Environment variables:

```bash
export EDGETERM_DB_HOST=10.0.0.20
export EDGETERM_DB_PORT=3306
export EDGETERM_DB_NAME=edgeterm
export EDGETERM_DB_USER=edgeterm
export EDGETERM_DB_PASSWORD='your-password'
```

Or CLI arguments:

```bash
python backend/app.py \
  --host 0.0.0.0 \
  --port 8082 \
  --db-host 10.0.0.20 \
  --db-port 3306 \
  --db-name edgeterm \
  --db-user edgeterm \
  --db-password 'your-password'
```

The normalized MySQL schema uses these tables:

- `users`
- `sessions`
- `snapshots`
- `shares`
- `share_allowed_users`
- `tiers`
- `settings`

The legacy `edgeterm_state` table is still written as a compatibility/migration snapshot, but the live backend now reads and writes the normalized tables.

### Linux production example

```bash
cd /home/python/edgeterm
npm install
python3 -m pip install -r backend/requirements.txt
npm run build:cloud
cp -r build/* backend/static/

cd backend
cp .env.example .env
# edit .env with your real values
python3 -m waitress --host=0.0.0.0 --port=9092 --call "app:create_app"
```

`backend/app.py` now loads environment variables from:

- repo root `.env`
- `backend/.env`

Supported keys:

- `EDGETERM_HOST`
- `EDGETERM_PORT`
- `EDGETERM_CLOUD_DIR`
- `EDGETERM_DB_HOST`
- `EDGETERM_DB_PORT`
- `EDGETERM_DB_NAME`
- `EDGETERM_DB_USER`
- `EDGETERM_DB_PASSWORD`

## Frontend build flags

The frontend runtime reads:

- `window.EDGETERM_CLOUD_ENABLED`
- `window.EDGETERM_PAGE_KIND`
- `window.EDGETERM_ASSET_BASE`

That allows the same runtime bundle to run as:

- offline main app
- cloud main app
- cloud share page
- cloud admin page

## Notes

- `serve-edgeterm.py` remains in the repo as legacy local tooling, but the Cloud Edition path is now `backend/app.py`.
- Cloud Edition serves HTML and API responses only. Runtime execution stays client-side.
