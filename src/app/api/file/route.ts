import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url");
  const isAuthenticated = request.cookies.has("auth_token");

  if (!isAuthenticated) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  if (!url) {
    return new NextResponse("Missing URL", { status: 400 });
  }

  try {
    const response = await fetch(url, {
      headers: {
        // We must pass the Vercel Blob token to authorize downloading the private file
        Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`
      }
    });

    if (!response.ok) {
      return new NextResponse("Failed to fetch file from Blob storage", { status: response.status });
    }

    // Proxy the response headers (like Content-Type) and body back to the client
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    return new NextResponse(response.body, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=3600"
      }
    });
  } catch (error) {
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
