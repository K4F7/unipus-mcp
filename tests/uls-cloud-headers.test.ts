import { test } from "node:test";
import assert from "node:assert/strict";
import { ulsCloudHeaders, openIdFromJwt } from "../src/uls-business.js";

const jwt = (p: object) => `h.${Buffer.from(JSON.stringify(p)).toString("base64url")}.s`;

test("ulsCloudHeaders defaults openid from JWT (ebcp/conversation 500 without it)", () => {
  const h = ulsCloudHeaders(jwt({ openId: "oid-x" }));
  assert.equal(h.openid, "oid-x");
  assert.equal(h.origin, "https://uadaptive.unipus.cn");
  assert.equal(ulsCloudHeaders(jwt({ openId: "a" }), undefined, "b").openid, "b");
  assert.equal(openIdFromJwt("Bearer " + jwt({ openId: "c" })), "c");
  assert.equal(ulsCloudHeaders("garbage").openid, undefined);
});
