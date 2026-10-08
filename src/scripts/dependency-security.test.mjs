import assert from "node:assert/strict";
import {
  constants,
  generateKeyPairSync,
  privateEncrypt,
  sign,
} from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const workspaceRequire = createRequire(
  new URL("../packages/package.json", import.meta.url),
);
const liteRequire = createRequire(
  new URL("../packages/lite/package.json", import.meta.url),
);
const frontendRequire = createRequire(
  new URL("../packages/frontend/package.json", import.meta.url),
);

function dependencyRequire(parent, name) {
  return createRequire(parent.resolve(name));
}

const forge = dependencyRequire(liteRequire, "selfsigned")("node-forge");
const globbyRequire = dependencyRequire(
  dependencyRequire(workspaceRequire, "check-dependency-version-consistency"),
  "globby",
);
const micromatchRequire = dependencyRequire(
  dependencyRequire(globbyRequire, "fast-glob"),
  "micromatch",
);
const braces = micromatchRequire("braces");
const katex = frontendRequire("katex");
const proxyAddr = dependencyRequire(liteRequire, "express")("proxy-addr");

test("Forge accepts valid signatures and rejects extra nested DigestAlgorithm elements", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const verifier = forge.pki.publicKeyFromPem(
    publicKey.export({ type: "spki", format: "pem" }),
  );
  const message = Buffer.from("CoCalc dependency verification fixture");
  const digest = forge.md.sha256
    .create()
    .update(message.toString())
    .digest()
    .getBytes();
  const signature = sign("sha256", message, privateKey);
  assert.equal(verifier.verify(digest, signature.toString("binary")), true);

  const { asn1 } = forge;
  const sequence = (children) =>
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, children);
  const oid = () =>
    asn1.create(
      asn1.Class.UNIVERSAL,
      asn1.Type.OID,
      false,
      asn1.oidToDer(forge.pki.oids.sha256).getBytes(),
    );
  const nullParameter = () =>
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, "");
  const octets = (value) =>
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, value);
  const makeSignature = (algorithm) => {
    const encoded = asn1
      .toDer(sequence([sequence(algorithm), octets(digest)]))
      .getBytes();
    return privateEncrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(encoded, "binary"),
    ).toString("binary");
  };

  for (const algorithm of [[oid()], [oid(), nullParameter()]]) {
    assert.equal(verifier.verify(digest, makeSignature(algorithm)), true);
  }
  for (const algorithm of [
    [oid(), nullParameter(), octets("extra")],
    [oid(), octets("extra")],
    [oid(), nullParameter(), nullParameter()],
  ]) {
    assert.throws(
      () => verifier.verify(digest, makeSignature(algorithm)),
      /valid RSASSA-PKCS1-v1_5 DigestInfo/,
    );
  }
});

test("Forge patch preserves self-signed certificate generation", () => {
  const pems = liteRequire("selfsigned").generate(
    [{ name: "commonName", value: "localhost" }],
    {
      keySize: 2048,
      algorithm: "sha256",
      days: 1,
    },
  );
  const certificate = forge.pki.certificateFromPem(pems.cert);
  assert.equal(certificate.verify(certificate), true);
});

test("braces preserves ordinary expansion and its existing limits", () => {
  assert.deepEqual(braces.expand("src/{frontend,server}/*.{ts,tsx}"), [
    "src/frontend/*.ts",
    "src/frontend/*.tsx",
    "src/server/*.ts",
    "src/server/*.tsx",
  ]);
  assert.deepEqual(braces("{a,b}"), ["(a|b)"]);
  assert.throws(() => braces("a".repeat(10001)), SyntaxError);
  assert.throws(
    () => braces.expand("{1..1001}", { rangeLimit: 100 }),
    RangeError,
  );
});

for (const [name, opening, closing] of [
  ["braces", "{", "}"],
  ["parentheses", "(", ")"],
  ["mixed groups", "{(", ")}"],
]) {
  for (const expand of [false, true]) {
    test(`braces rejects excessive ${name} nesting before recursive walking (expand=${expand})`, () => {
      const pattern = opening.repeat(2000) + "x" + closing.repeat(2000);
      assert.ok(pattern.length < 10000);
      assert.throws(() => braces(pattern, { expand }), {
        name: "SyntaxError",
        message: /nesting depth/,
      });
      assert.throws(() => braces(opening.repeat(2000), { expand }), {
        name: "SyntaxError",
        message: /nesting depth/,
      });
    });
  }
}

test("braces depth limit respects balanced groups and literal syntax", () => {
  assert.doesNotThrow(() =>
    braces("{".repeat(128) + "a,b" + "}".repeat(128), { expand: true }),
  );
  assert.throws(
    () => braces("{".repeat(129) + "x" + "}".repeat(129)),
    /nesting depth/,
  );
  assert.doesNotThrow(() => braces("{a,b}".repeat(200)));
  for (const pattern of [
    "\\{".repeat(500),
    '"' + "{".repeat(500) + '"',
    "[" + "{".repeat(500) + "]",
  ]) {
    assert.doesNotThrow(() => braces(pattern, { expand: true }));
  }
});

test("KaTeX renders math but does not inherit trust from options prototypes", () => {
  assert.match(katex.renderToString("\\frac{a}{b}"), /katex-mathml/);
  const source = "\\href{https://example.test/}{link}";
  assert.match(katex.renderToString(source, { trust: true }), /href=/);
  assert.doesNotMatch(
    katex.renderToString(source, Object.create({ trust: true })),
    /href=/,
  );
});

test("proxy-addr does not widen short IPv4-mapped subnet trust", () => {
  const invalid = proxyAddr.compile(["::ffff:10.0.0.0/8"]);
  const valid = proxyAddr.compile(["::ffff:10.0.0.0/104"]);
  for (const address of ["203.0.113.9", "::ffff:203.0.113.9", "10.0.0.1"]) {
    assert.equal(invalid(address), false);
  }
  assert.equal(valid("10.0.0.1"), true);
  assert.equal(valid("203.0.113.9"), false);
  const request = {
    socket: { remoteAddress: "203.0.113.9" },
    headers: { "x-forwarded-for": "10.0.0.1" },
  };
  assert.equal(proxyAddr(request, invalid), "203.0.113.9");
});
