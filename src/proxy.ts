// Dashboard login (HTTP Basic auth). Active whenever APP_PASSWORD is set — and
// live trading refuses to enable without it. Any username, password = APP_PASSWORD.
// `/api` itself (a static hello-world) stays open for the platform health check.
import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function proxy(req: NextRequest) {
  const password = (process.env.APP_PASSWORD ?? "").trim();
  if (!password) return NextResponse.next();

  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString();
    const given = decoded.slice(decoded.indexOf(":") + 1);
    if (safeEqual(given, password)) return NextResponse.next();
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Neuro Bot", charset="UTF-8"' },
  });
}

export const config = {
  matcher: ["/((?!api$|_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
