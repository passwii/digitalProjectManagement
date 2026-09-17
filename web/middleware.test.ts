import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { middleware } from "./middleware";

test("middleware allows the protected shell when only the session hint exists", () => {
  const request = new NextRequest("http://localhost:3000/dashboard", {
    headers: { cookie: "pm_session=1" },
  });

  const response = middleware(request);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("location"), null);
});
