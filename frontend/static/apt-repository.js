export function stagedAptSource(runtimeRoot = "/home/user") {
  return [
    "Types: deb",
    `URIs: file:${runtimeRoot.replace(/\/+$/, "")}/apt-repository`,
    "Suites: ./",
    "Architectures: wasm32-wasix all",
    "Signed-By: 6165B5AE16F62EE3D31837905CECF54DFEE8CFBD",
    // The browser verifies InRelease and the index before staging this local mirror.
    "Trusted: yes",
    "",
  ].join("\n");
}

export async function configureStagedAptRepository(etc, directory, runtimeRoot = "/home/user") {
  let index;
  try {
    index = await directory.readFile("/apt-repository/Packages");
  } catch {
    return false;
  }
  if (!/^Package:\s+\S+/m.test(new TextDecoder().decode(index))) return false;
  await etc.writeFile("/apt/sources.list.d/edgeterm-local.sources", new TextEncoder().encode(stagedAptSource(runtimeRoot)));
  return true;
}
