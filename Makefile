offline:
	npm run build:offline
	mkdir -p dist-offline
	cp -r build/* dist-offline/

cloud:
	npm run build:cloud
	mkdir -p dist-cloud
	mkdir -p backend/static
	cp -r build/* backend/static/
	cp -r backend dist-cloud/

clean:
	rm -rf dist-offline dist-cloud build backend/static/assets backend/static/rootfs.zip backend/static/wasm-cli-worker.js

run:
	cd backend && python app.py
