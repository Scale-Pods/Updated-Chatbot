import { NextResponse, type NextRequest } from "next/server"
import { createServerSupabaseClient } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

interface ChatRow {
  id: number
  session_id: string
  role: string | null
  content: string | null
  created_at: string | null
  /** Name of the human agent handling the conversation, when present. */
  Agent: string | null
}

/**
 * GET /api/chat/messages?session_id=<uuid>&after_id=<id>
 *
 * Returns rows from public."Chat Data" for a single session, ordered oldest
 * first. When `after_id` is provided, only rows with a greater id are returned
 * (used for polling). The numeric id is used instead of created_at because rows
 * inserted in the same transaction share an identical created_at.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const sessionId = searchParams.get("session_id")
  const afterId = searchParams.get("after_id")

  if (!sessionId) {
    return NextResponse.json(
      { error: "session_id is required" },
      { status: 400 },
    )
  }

  try {
    const supabase = createServerSupabaseClient()

    let query = supabase
      .from("Chat Data")
      .select("id, session_id, role, content, created_at, Agent")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })

    if (afterId) {
      const parsedAfterId = Number.parseInt(afterId, 10)
      if (!Number.isNaN(parsedAfterId)) {
        query = query.gt("id", parsedAfterId)
      }
    }

    const { data, error } = await query

    if (error) {
      console.error("[chat/messages] Supabase error:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const messages = (data ?? []) as ChatRow[]

    return NextResponse.json({
      count: messages.length,
      messages,
    })
  } catch (error) {
    console.error("[chat/messages] Unexpected error:", error)
    const message =
      error instanceof Error ? error.message : "Unexpected server error"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
