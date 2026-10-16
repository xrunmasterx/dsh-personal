/** Build-only adapter for 0.1.6's workspace-only Remote decorator discovery. */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const original = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-typert-generator'))
const source = await readFile(original, 'utf8')
const anchor = '\t\tif (this.registrationForFile(declaration.getSourceFile().fileName)?.name === "@deepseek-ai/dsh-typert-protocol") return true;'
if (source.split(anchor).length !== 2) throw new Error('Unsupported Typert generator; review the external-package compatibility adapter')
const adapted = source.replace(anchor, anchor + `
        // Published declarations are owned by their nearest npm package.
        let owner = dirname(declaration.getSourceFile().fileName);
        while (dirname(owner) !== owner) {
            const manifest = join(owner, "package.json");
            if (existsSync(manifest)) {
                if (JSON.parse(readFileSync(manifest, "utf8")).name === "@deepseek-ai/dsh-typert-protocol") return true;
                break;
            }
            owner = dirname(owner);
        }`)
const directory = fileURLToPath(new URL('../.local/build/', import.meta.url))
await mkdir(directory, { recursive: true })
const output = `${directory}/typert-generator.mjs`
await writeFile(output, adapted)
export const { WorkspaceTypertGenerator } = await import(pathToFileURL(output).href)
