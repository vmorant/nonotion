// Base de datos temporal para cada archivo de test (node --test ejecuta cada
// archivo en su propio proceso). Importar ANTES que cualquier módulo del servidor.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nonotion-test-'));
process.env.DATA_DIR = DATA_DIR;
process.on('exit', () => fs.rmSync(DATA_DIR, { recursive: true, force: true }));
