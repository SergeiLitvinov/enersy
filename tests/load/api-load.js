import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

const errorRate = new Rate("errors");

export const options = {
  stages: [
    { duration: "30s", target: 10 },
    { duration: "1m", target: 20 },
    { duration: "30s", target: 0 },
  ],
  thresholds: {
    errors: ["rate<0.05"],
    http_req_duration: ["p(95)<500"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:8080";

export default function () {
  const responses = http.batch([
    ["GET", `${BASE_URL}/health`, null, { tags: { name: "health" } }],
    ["GET", `${BASE_URL}/api/ees/component-types`, null, {
      tags: { name: "component-types" },
    }],
    ["GET", `${BASE_URL}/version`, null, { tags: { name: "version" } }],
  ]);

  responses.forEach((res) => {
    check(res, {
      "status is 200": (r) => r.status === 200,
    });
    errorRate.add(res.status !== 200);
  });

  sleep(1);
}