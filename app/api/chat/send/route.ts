import { NextResponse, type NextRequest } from "next/server"
import { corsHeaders } from "@/lib/cors"

export const dynamic = "force-dynamic"

/**
 * POST /api/chat/send
 *
 * Forwards a chat message to the n8n send webhook. The upstream URL is read
 * from the server-side `N8N_WEBHOOK_URL` environment variable and is never
 * exposed to the browser.
 */
export async function POST(request: NextRequest) {
  const webhookUrl = process.env.N8N_WEBHOOK_URL

  if (!webhookUrl) {
    console.error("[chat/send] Missing N8N_WEBHOOK_URL environment variable")
    return NextResponse.json(
      { error: "Chat service is not configured" },
      { status: 500, headers: corsHeaders() },
    )
  }

  try {
    const body = await request.text()

    const upstream = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type":
          request.headers.get("content-type") || "application/json",
      },
      body,
      cache: "no-store",
    })

    const responseBody = await upstream.text()

    return new NextResponse(responseBody, {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("content-type") || "application/json",
        ...corsHeaders(),
      },
    })
  } catch (error) {
    console.error("[chat/send] Error forwarding message:", error)
    const message =
      error instanceof Error ? error.message : "Unexpected server error"
    return NextResponse.json(
      { error: message },
      { status: 502, headers: corsHeaders() },
    )
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}
