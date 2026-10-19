// Mocha entry point inside the VS Code test instance: runs the test file of the suite USPEC_SUITE names.
import Mocha from 'mocha';
import * as path from 'path';

export function run(): Promise<void> {
  const suite = process.env.USPEC_SUITE ?? 'flow';
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: suite === 'live' ? 900_000 : 60_000 });
  mocha.addFile(path.join(__dirname, `${suite}.test.js`));
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} integration tests failed`)) : resolve()));
  });
}
