import os
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph
from reportlab.lib.styles import ParagraphStyle

pdf_path = r"c:\Users\Pratham Vatsa\Desktop\Vatsom\resume\Pratham_Vatsa_Resume.pdf"
portrait_path = r"c:\Users\Pratham Vatsa\Desktop\Vatsom\resume\pratham_portrait_crop.jpg"

c = canvas.Canvas(pdf_path, pagesize=A4)
width, height = A4  # 595.27 x 841.89 pt

# Colors matching Vatsom Atelier Palette
COLOR_CHARCOAL = colors.HexColor("#121212")
COLOR_PAPER = colors.HexColor("#f4f1ea")
COLOR_PAPER_DARK = colors.HexColor("#e5dec9")
COLOR_PAPER_EDGE = colors.HexColor("#d6ccb2")
COLOR_GOLD = colors.HexColor("#c5a059")
COLOR_GOLD_LIGHT = colors.HexColor("#e2ca97")
COLOR_WAX_RED = colors.HexColor("#7c1d1d")
COLOR_TEXT_MUTED = colors.HexColor("#2e2e2e")
COLOR_SIDE_TEXT_MUTED = colors.HexColor("#dcd5c9")

# Layout Dimensions
SIDE_WIDTH = 192.0
MAIN_LEFT = SIDE_WIDTH
MAIN_WIDTH = width - SIDE_WIDTH

# 1. Backgrounds
# Right Side: Parchment
c.setFillColor(COLOR_PAPER)
c.rect(SIDE_WIDTH, 0, MAIN_WIDTH, height, fill=1, stroke=0)

# Subtle Ribbed lines texture on Parchment
c.setStrokeColor(colors.Color(0, 0, 0, alpha=0.03))
c.setLineWidth(0.4)
y = 0
while y < height:
    c.line(SIDE_WIDTH, y, width, y)
    y += 2.6

# Left Side: Obsidian Charcoal
c.setFillColor(COLOR_CHARCOAL)
c.rect(0, 0, SIDE_WIDTH, height, fill=1, stroke=0)

# Golden Divider line between Sidebar and Main
c.setStrokeColor(COLOR_GOLD)
c.setLineWidth(1.2)
c.line(SIDE_WIDTH, 0, SIDE_WIDTH, height)

# =============================================================================
# 2. SIDEBAR CONTENT (PORTRAIT & PROFILE)
# =============================================================================

# Elegant Framed Portrait at top of sidebar
PHOTO_W = 104.0
PHOTO_H = 138.0  # 3:4 aspect ratio
PHOTO_X = (SIDE_WIDTH - PHOTO_W) / 2.0
PHOTO_Y = height - 164.0

# Minimalist gold frame matting
c.setStrokeColor(COLOR_GOLD)
c.setLineWidth(0.8)
c.setFillColor(COLOR_CHARCOAL)
# Outer subtle border
c.rect(PHOTO_X - 3.5, PHOTO_Y - 3.5, PHOTO_W + 7.0, PHOTO_H + 7.0, fill=0, stroke=1)
# Inner hairline border
c.setStrokeColor(colors.Color(197/255, 160/255, 89/255, alpha=0.4))
c.setLineWidth(0.4)
c.rect(PHOTO_X - 1.2, PHOTO_Y - 1.2, PHOTO_W + 2.4, PHOTO_H + 2.4, fill=0, stroke=1)

# Draw image
if os.path.exists(portrait_path):
    c.drawImage(portrait_path, PHOTO_X, PHOTO_Y, width=PHOTO_W, height=PHOTO_H, preserveAspectRatio=True)

def draw_sidebar_header(title, y_pos):
    c.setFont("Helvetica-Bold", 7.6)
    c.setFillColor(COLOR_GOLD)
    c.drawString(18, y_pos, title.upper())
    c.setStrokeColor(COLOR_GOLD)
    c.setLineWidth(0.6)
    c.line(18, y_pos - 3, SIDE_WIDTH - 18, y_pos - 3)
    return y_pos - 13

cur_sy = PHOTO_Y - 18.0

# Contact Section
cur_sy = draw_sidebar_header("Contact Details", cur_sy)
contact_items = [
    ("NAME", "Pratham Vatsa"),
    ("PHONE", "+91 9999930048"),
    ("EMAIL", "pratham1879@gmail.com"),
    ("PORTFOLIO", "vatsom.in (Founder)"),
    ("LOCATION", "Dehradun / Delhi NCR, India")
]
for lbl, val in contact_items:
    c.setFont("Helvetica-Bold", 6.2)
    c.setFillColor(COLOR_GOLD)
    c.drawString(18, cur_sy, lbl)
    cur_sy -= 8
    c.setFont("Helvetica", 7.2)
    c.setFillColor(COLOR_PAPER)
    c.drawString(18, cur_sy, val)
    cur_sy -= 9.5

cur_sy -= 3

# Technical Skills Section
cur_sy = draw_sidebar_header("Technical Skills", cur_sy)

def draw_side_skill_group(group_title, skills, start_y):
    c.setFont("Times-Italic", 7.8)
    c.setFillColor(COLOR_PAPER_EDGE)
    c.drawString(18, start_y, group_title)
    y = start_y - 11
    x = 18
    for sk in skills:
        w = c.stringWidth(sk, "Helvetica", 6.6) + 7
        if x + w > SIDE_WIDTH - 16:
            x = 18
            y -= 12
        # Chip box
        c.setStrokeColor(colors.Color(197/255, 160/255, 89/255, alpha=0.5))
        c.setLineWidth(0.4)
        c.setFillColor(COLOR_CHARCOAL)
        c.rect(x, y - 2, w, 9.5, fill=1, stroke=1)
        c.setFont("Helvetica", 6.6)
        c.setFillColor(COLOR_PAPER)
        c.drawString(x + 3.5, y, sk)
        x += w + 3.5
    return y - 13

cur_sy = draw_side_skill_group("Data & Analytics", ["Advanced Excel", "Pivot Tables", "SQL", "Python (Pandas)", "Data Analysis", "Power BI"], cur_sy)
cur_sy = draw_side_skill_group("Business Systems", ["E-commerce Ops", "KPI Reporting", "Inventory Sourcing", "Process Docs"], cur_sy)
cur_sy = draw_side_skill_group("Productivity", ["MS PowerPoint", "Word", "Excel"], cur_sy)

cur_sy -= 2

# Core Business Competencies
cur_sy = draw_sidebar_header("Core Competencies", cur_sy)
c.setFont("Helvetica", 7.0)
c.setFillColor(COLOR_PAPER)
competencies = [
    "Procurement Fundamentals",
    "Vendor & Supplier Sourcing",
    "Strategic Sourcing & Evaluation",
    "Inventory & Reorder Planning",
    "Business Operations & Auditing",
    "Cost Analysis & Negotiation",
    "Category & Product Strategy",
    "Market Research & Positioning",
    "Stakeholder Communication"
]
for comp in competencies:
    c.setFillColor(COLOR_GOLD)
    c.rect(18, cur_sy + 1.5, 2.8, 2.8, fill=1, stroke=0)
    c.setFillColor(COLOR_PAPER)
    c.drawString(25, cur_sy, comp)
    cur_sy -= 10.5

cur_sy -= 3

# Interests
cur_sy = draw_sidebar_header("Additional Interests", cur_sy)
c.setFont("Helvetica-Bold", 7.0)
c.setFillColor(COLOR_PAPER)
c.drawString(18, cur_sy, "Competitive Basketball")
cur_sy -= 8
c.setFont("Helvetica", 6.6)
c.setFillColor(COLOR_SIDE_TEXT_MUTED)
c.drawString(18, cur_sy, "Team participation and competitive athletic experience.")
cur_sy -= 11

c.setFont("Helvetica-Bold", 7.0)
c.setFillColor(COLOR_PAPER)
c.drawString(18, cur_sy, "Music Production")
cur_sy -= 8
c.setFont("Helvetica", 6.6)
c.setFillColor(COLOR_SIDE_TEXT_MUTED)
c.drawString(18, cur_sy, "Professional ghost producer: sound design, DAWs, mixing,")
cur_sy -= 7.5
c.drawString(18, cur_sy, "and audio pipeline production workflows.")

# =============================================================================
# 3. MAIN CONTENT (PARCHMENT CANVAS)
# =============================================================================
mx = SIDE_WIDTH + 22
m_right = width - 20
m_width = m_right - mx
my = height - 32

# Header Name
c.setFont("Times-Bold", 23)
c.setFillColor(COLOR_CHARCOAL)
c.drawString(mx, my, "PRATHAM VATSA")
my -= 14

# Headline
c.setFont("Times-Italic", 10.2)
c.setFillColor(COLOR_WAX_RED)
c.drawString(mx, my, "Founder  |  Business Operations  |  Procurement & Supply Chain")
my -= 11

c.setFont("Helvetica-Bold", 7.0)
c.setFillColor(colors.HexColor("#555555"))
c.drawString(mx, my, "SOURCING  •  OPERATIONS  •  ANALYTICS  •  DIGITAL COMMERCE")
my -= 8

# Gold Accent Line
c.setStrokeColor(COLOR_GOLD)
c.setLineWidth(1)
c.line(mx, my, m_right, my)
my -= 14

def draw_main_section(title, start_y):
    # Diamond accent
    c.setFillColor(COLOR_GOLD)
    c.rect(mx, start_y + 1, 3.8, 3.8, fill=1, stroke=0)
    c.setFont("Times-Bold", 9.8)
    c.setFillColor(COLOR_CHARCOAL)
    c.drawString(mx + 8, start_y, title.upper())
    # Subtly underline section header
    c.setStrokeColor(colors.Color(18/255, 18/255, 18/255, alpha=0.18))
    c.setLineWidth(0.5)
    c.line(mx + c.stringWidth(title.upper(), "Times-Bold", 9.8) + 14, start_y + 3, m_right, start_y + 3)
    return start_y - 12

# Professional Summary
my = draw_main_section("Professional Summary", my)

style_summary = ParagraphStyle(
    name="Summary",
    fontName="Times-Roman",
    fontSize=8.4,
    leading=11.4,
    textColor=COLOR_TEXT_MUTED
)

summary_html = (
    "<b>BBA graduate (Marketing)</b> with hands-on experience in <b>business operations, e-commerce management, "
    "vendor coordination and analytics</b>. Founder of <b>Vatsom</b>, a premium edible and aromatic oils brand, where I "
    "lead product sourcing, business strategy, website operations and go-to-market execution. Strong analytical foundation "
    "in <b>Excel, SQL, Python (Pandas) and data analysis</b>, with a core strategic focus on <b>procurement, supply chain management, "
    "supplier evaluation and operational scaling</b>."
)
p = Paragraph(summary_html, style_summary)
pw, ph = p.wrap(m_width, 100)
p.drawOn(c, mx, my - ph)
my -= (ph + 12)

# Experience
my = draw_main_section("Professional Experience", my)

def draw_experience_item(title, org, date, bullets, start_y):
    c.setFont("Times-Bold", 9.6)
    c.setFillColor(COLOR_CHARCOAL)
    c.drawString(mx, start_y, title)
    
    c.setFont("Helvetica-Bold", 7.4)
    c.setFillColor(COLOR_WAX_RED)
    date_w = c.stringWidth(date, "Helvetica-Bold", 7.4)
    c.drawString(m_right - date_w, start_y, date)
    
    start_y -= 9.5
    c.setFont("Times-Italic", 8.6)
    c.setFillColor(colors.HexColor("#444444"))
    c.drawString(mx, start_y, org)
    start_y -= 9.5
    
    bullet_style = ParagraphStyle(
        name="Bullet",
        fontName="Helvetica",
        fontSize=7.4,
        leading=9.8,
        textColor=COLOR_TEXT_MUTED
    )
    
    for b in bullets:
        c.setFillColor(COLOR_GOLD)
        c.rect(mx + 2, start_y - 4, 2.8, 2.8, fill=1, stroke=0)
        
        bp = Paragraph(b, bullet_style)
        bw, bh = bp.wrap(m_width - 12, 100)
        bp.drawOn(c, mx + 9, start_y - bh + 1)
        start_y -= (bh + 4.0)
        
    return start_y - 3.5

vatsom_bullets = [
    "<b>Brand & Sourcing Leadership:</b> Founded and launched Vatsom; directed product strategy, raw botanical sourcing, supplier evaluation and premium market positioning.",
    "<b>Digital Infrastructure & Operations:</b> Architected and launched full-stack production commerce infrastructure on Cloudflare Workers & PostgreSQL with COD order sealing, stock reservation, and administrative control.",
    "<b>Supply Chain & Expansion:</b> Managing marketplace onboarding, packaging vendor coordination, and cold-pressed botanical procurement channels.",
    "<b>Business Intelligence:</b> Built KPI tracking models and order monitoring dashboards to optimize unit economics, margins, and fulfillment latency."
]
my = draw_experience_item("FOUNDER", "Vatsom — Premium Botanical Atelier (vatsom.in)", "2026 – PRESENT", vatsom_bullets, my)

pratham_bullets = [
    "<b>Supplier Coordination:</b> Directing multi-vendor negotiations, material procurement, and contract coordination across business operations."
]
my = draw_experience_item("PROPRIETOR", "Pratham Enterprises", "2026 – PRESENT", pratham_bullets, my)

jagriti_bullets = [
    "<b>Outreach & Campaigns:</b> Spearheaded awareness campaigns, marketing strategy, and synchronized volunteer outreach initiatives."
]
my = draw_experience_item("HEAD OF MARKETING TEAM", "Mission Jagriti (NGO)", "JUN 2024 – SEP 2024", jagriti_bullets, my)

# Projects
my = draw_main_section("Key Projects", my)
platform_bullets = [
    "<b>Vatsom E-Commerce Engine:</b> Deployed production platform featuring role-based authorization, idempotent COD checkout, race-condition stock locking, and automated notification dispatch.",
    "<b>Chancery Admin Ledger:</b> Developed central management dashboard for inventory batch adjustments, courier AWB tracking integration, and audit logging."
]
my = draw_experience_item("VATSOM PRODUCTION COMMERCE PLATFORM", "Independent System Architecture", "2026", platform_bullets, my)

# Leadership & E-Cell
my = draw_main_section("Leadership & Entrepreneurship", my)
ecell_bullets = [
    "<b>E-Cell UPES:</b> Participated in venture evaluation, early-stage investor pitching sessions, and analyzed scalable supply chain models of emerging startups."
]
my = draw_experience_item("ENTREPRENEURSHIP CELL (E-CELL)", "University of Petroleum and Energy Studies (UPES)", "2023 – 2026", ecell_bullets, my)

# Education
my = draw_main_section("Education", my)
c.setFont("Times-Bold", 9.2)
c.setFillColor(COLOR_CHARCOAL)
c.drawString(mx, my, "BACHELOR OF BUSINESS ADMINISTRATION (MARKETING)")
c.setFont("Helvetica-Bold", 7.4)
c.setFillColor(COLOR_WAX_RED)
deg_date = "2023 – 2026"
c.drawString(m_right - c.stringWidth(deg_date, "Helvetica-Bold", 7.4), my, deg_date)
my -= 9

c.setFont("Times-Italic", 8.6)
c.setFillColor(colors.HexColor("#444444"))
c.drawString(mx, my, "UPES (University of Petroleum and Energy Studies)")
my -= 10

# Coursework tags
edu_tags = [
    "Operations Management", "Strategic Management", "Procurement & Sourcing",
    "Brand Management", "Consumer Behaviour", "Business Communication", "HR Management"
]
tx = mx
for t in edu_tags:
    tw = c.stringWidth(t, "Helvetica", 6.6) + 7
    c.setFillColor(COLOR_PAPER_DARK)
    c.setStrokeColor(COLOR_PAPER_EDGE)
    c.setLineWidth(0.4)
    c.rect(tx, my - 2, tw, 9.2, fill=1, stroke=1)
    c.setFont("Helvetica", 6.6)
    c.setFillColor(COLOR_CHARCOAL)
    c.drawString(tx + 3.5, my, t)
    tx += tw + 3.5

# Footer signature
c.setFont("Times-Italic", 6.8)
c.setFillColor(colors.HexColor("#888888"))
c.drawCentredString(SIDE_WIDTH + (MAIN_WIDTH / 2.0), 12, "CURRICULUM VITAE  •  PRATHAM VATSA  •  OPERATIONS & SOURCING")

c.save()
print("PDF successfully updated at:", pdf_path)
