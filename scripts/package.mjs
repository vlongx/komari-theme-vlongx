// Build the Komari theme zip: preview.png + komari-theme.json + dist/
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

const output = "komari-theme-tasogare-gpu-2.2.2-komari.zip";

for (const file of ["preview.png", "komari-theme.json", "dist/index.html"]) {
  if (!existsSync(file)) {
    console.error(`missing ${file} — run \`npm run build\` first`);
    process.exit(1);
  }
}

execSync(
  `python3 -c "
import zipfile, os
with zipfile.ZipFile('${output}','w',zipfile.ZIP_DEFLATED) as z:
    z.write('preview.png')
    z.write('komari-theme.json')
    for root,_,files in os.walk('dist'):
        for f in files:
            p=os.path.join(root,f); z.write(p)
print('created ${output}')"`,
  { stdio: "inherit" },
);
