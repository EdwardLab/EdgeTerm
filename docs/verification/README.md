# Release verification, 7 September 2026

The public repository report records the size and SHA-256 of every package fetched
from the production HTTPS origin. The package acceptance summary preserves the
artifact-bound gate outcomes and evidence hashes; local publisher paths are omitted.

The browser suite uses Chrome, creates an isolated workspace, and exercises actual
commands and rendered previews. Run `npm run test:browser` with an Embed build.
Use `?production=1` to test the default public repository. This mode omits the
controlled outage check because the suite must not interrupt the public service.
Use a build with `EDGETERM_APT_REPOSITORY_URL=/edgeterm-packages/local-flat` and no
query string to include the HTTP 503 failure test. `?focus=lifecycle` runs the
package removal regression alone.

The full CI workflow downloads the pinned runtime assets into a clean checkout,
builds all three editions, runs the frontend and Bridge tests, and exercises backend
routes against an isolated MySQL 8.4 service. It does not use the publisher's local
runtime cache or application data.

External OAuth backup providers and remote socket services are outside this
release's live browser acceptance scope. Their unit coverage is not a remote
integration claim. Node compatibility remains limited to the documented runtime
and frontend build adapters.

Results: 28/28 production browser checks passed, plus the separately recorded
HTTP 503 failure check. Frontend/runtime: 265/265 and Bridge protocol tests.
Backend: 25/25, including real MySQL 8.4. Package repository: 43/43.
