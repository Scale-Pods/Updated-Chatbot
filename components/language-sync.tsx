"use client"

import { useEffect, useState } from "react"

/**
 * Detects the browser language on the client, keeps the <html> lang/dir
 * attributes in sync, and injects the widget's global layout styles.
 */
export function LanguageSync() {
  const [lang, setLang] = useState<"en" | "ar">("en")
  const [dir, setDir] = useState<"ltr" | "rtl">("ltr")

  useEffect(() => {
    // Detect browser language
    const browserLang = navigator.language || "en"
    const isArabic = browserLang.startsWith("ar")

    setLang(isArabic ? "ar" : "en")
    setDir(isArabic ? "rtl" : "ltr")

    // Update HTML element attributes
    const htmlElement = document.documentElement
    htmlElement.lang = isArabic ? "ar" : "en"
    htmlElement.dir = isArabic ? "rtl" : "ltr"
  }, [])

  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `
          html, body {
            pointer-events: none !important;
            background: transparent !important;
            margin: 0;
            padding: 0;
            overflow: hidden;
            font-family: ${lang === "ar" ? "'Cairo', 'Noto Sans Arabic', sans-serif" : "'Geist', sans-serif"};
          }
          #chatbot-root {
            position: fixed;
            bottom: 15px;
            ${dir === "rtl" ? "left: 15px;" : "right: 15px;"}
            pointer-events: auto !important;
          }
          #chatbot-root * {
            pointer-events: auto !important;
          }
        `,
      }}
    />
  )
}
