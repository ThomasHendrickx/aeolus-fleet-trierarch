import { describe, expect, it } from 'vitest';

import { configurationJsonSchema } from './files.js';

// The Go trierarch has no common to import: it embeds the configuration's JSON Schema this one writes (docs/design/trierarch-binary.md).
const GO_SCHEMA = '../../../../go/internal/config/config.schema.json';

describe("the Go trierarch's configuration schema", () => {
  it('is the JSON Schema of the configuration this trierarch accepts, so the two never drift (npm run go:schema writes it again)', async () => {
    await expect(`${JSON.stringify(configurationJsonSchema(), null, 2)}\n`).toMatchFileSnapshot(GO_SCHEMA);
  });
});
