' Aurora's first-run guided tour for Roku, built from SceneGraph nodes only: the screen is dimmed with four
' rectangles around a "hole", the real tile being explained is outlined in Aurora's gradient, and a small bundled
' arrow image points at it from a tooltip. The words and steps are in TourConfig.brs.
'
' Where a tile really is on screen comes from the tile itself: while the tour has the list focus on a tile, that
' tile reports its own on-screen rectangle (see TileItem.brs), so nothing here depends on a hard-coded position.
' Where the tooltip and arrow go is worked out from that rectangle (below a target near the top, above one near the
' bottom, beside one near an edge) and never leaves the screen.

sub tourInit()
    for each id in ["tourView", "tourArrow", "tourTip", "tipBg", "tipEdge", "tipAccent", "tipTitle", "tipText", "tipDots", "tipButtons", "tourBob", "tourBobI", "tourTimer", "tdimT", "tdimB", "tdimL", "tdimR", "tringT", "tringB", "tringL", "tringR"]
        m[id] = m.top.findNode(id)
    end for
    m.tipButtons.observeField("buttonSelected", "onTourButton")
    m.tourTimer.observeField("fire", "onTourTimeout")
    m.global.observeField("tileRect", "onTileRect")
    m.tourOn = false
    m.tourExpect = ""
    m.tourSteps = []
    m.tourBtns = []
end sub

function tourSeen() as boolean
    reg = CreateObject("roRegistrySection", "aurora")
    if not reg.Exists("tourSeen") then return false
    return Val(reg.Read("tourSeen")) >= tourSettings().version
end function

' Shows the tour by itself, once per device, when Home first appears after sign-in.
sub maybeStartTour()
    if m.tourOn or tourSeen() or m.updateRequired = true then return
    if m.top.dialog <> invalid then return
    tourStart()
end sub

' ---------- Finding the targets ----------

function tourFindTile(spec as object) as dynamic
    content = m.rowList.content
    if content = invalid then return invalid
    for r = 0 to content.getChildCount() - 1
        row = content.getChild(r)
        if spec.row <> invalid
            if row.title = spec.row and row.getChildCount() > 0 then return tourTile(row, r, 0)
        else if spec.action <> invalid
            for c = 0 to row.getChildCount() - 1
                if row.getChild(c).action = spec.action then return tourTile(row, r, c)
            end for
        end if
    end for
    return invalid
end function

function tourTile(row as object, r as integer, c as integer) as object
    node = row.getChild(c)
    return { row: r, col: c, key: txt(node.action) + "|" + txt(node.embyId) + "|" + Str(r).Trim() }
end function

function tourHasTargets(stp as object) as boolean
    if stp.center = true then return true
    if stp.tiles = invalid then return false
    for each spec in stp.tiles
        found = (tourFindTile(spec) <> invalid)
        if found and stp.any = true then return true
        if not found and stp.any <> true then return false
    end for
    return stp.any <> true
end function

' ---------- Running the tour ----------

sub tourStart()
    if m.tourOn or m.rowList.content = invalid then return
    ' Tiles reporting their own position needs a reasonably recent Roku OS; on an older one the tour just doesn't run.
    if CreateObject("roDeviceInfo").GetOSVersion().major.toInt() < 9 then return
    m.tourSteps = []
    for each stp in tourSteps()
        if tourHasTargets(stp) then m.tourSteps.push(stp)
    end for
    if m.tourSteps.count() = 0 then return
    m.tourOn = true
    m.global.tourWatching = true
    m.tourView.visible = true
    tourGoto(0, 1)
end sub

sub tourGoto(i as integer, dir as integer)
    if i >= m.tourSteps.count()
        tourEnd("done")
        return
    end if
    if i < 0 then i = 0
    m.tourIdx = i
    m.tourDir = dir
    stp = m.tourSteps[i]
    if stp.center = true
        tourShowStep(stp, invalid)
        return
    end if
    list = []
    for each spec in stp.tiles
        t = tourFindTile(spec)
        if t <> invalid then list.push(t)
    end for
    if list.count() = 0 then
        tourSkipCurrent()
        return
    end if
    m.tourWant = list
    m.tourGot = []
    m.tourK = 0
    tourPoke()
end sub

' The target is missing or never answered: leave the step out and carry on in the same direction.
sub tourSkipCurrent()
    m.tourExpect = ""
    m.tourTimer.control = "stop"
    m.tourSteps.delete(m.tourIdx)
    if m.tourSteps.count() = 0
        tourEnd("done")
        return
    end if
    if m.tourDir > 0 then tourGoto(m.tourIdx, 1) else tourGoto(m.tourIdx - 1, -1)
end sub

' Puts the list's focus on the next target tile so that tile reports where it is.
sub tourPoke()
    t = m.tourWant[m.tourK]
    m.tourExpect = t.key
    m.rowList.setFocus(true)
    m.rowList.jumpToRowItem = [t.row, t.col]
    m.tourTimer.control = "stop"
    m.tourTimer.control = "start"
end sub

sub onTourTimeout()
    if not m.tourOn or m.tourExpect = "" then return
    tourSkipCurrent()
end sub

sub onTileRect(event as object)
    if not m.tourOn or m.tourExpect = "" then return
    r = event.getData()
    if r = invalid or r.key <> m.tourExpect then return
    m.tourExpect = ""
    m.tourTimer.control = "stop"
    m.tourGot.push(r)
    m.tourK++
    if m.tourK < m.tourWant.count()
        tourPoke()
    else
        l = 99999 : t = 99999 : rt = 0 : b = 0
        for each g in m.tourGot
            if g.x < l then l = g.x
            if g.y < t then t = g.y
            if g.x + g.w > rt then rt = g.x + g.w
            if g.y + g.h > b then b = g.y + g.h
        end for
        tourShowStep(m.tourSteps[m.tourIdx], { left: l, top: t, right: rt, bottom: b })
    end if
end sub

sub onTourButton()
    action = m.tourBtns[m.tipButtons.buttonSelected]
    if action = "skip"
        tourEnd("skip")
    else if action = "back"
        tourGoto(m.tourIdx - 1, -1)
    else
        tourGoto(m.tourIdx + 1, 1)
    end if
end sub

sub tourEnd(how as string)
    if not m.tourOn then return
    m.tourOn = false
    m.global.tourWatching = false
    m.tourExpect = ""
    m.tourTimer.control = "stop"
    m.tourBob.control = "stop"
    m.tourView.visible = false
    reg = CreateObject("roRegistrySection", "aurora")
    reg.Write("tourSeen", Str(tourSettings().version).Trim())
    reg.Flush()
    m.rowList.jumpToRowItem = [0, 0]
    m.rowList.setFocus(true)
end sub

' The Back button ends the tour; every other key is left to the buttons.
function tourKey(key as string) as boolean
    if key = "back"
        tourEnd("skip")
        return true
    end if
    return false
end function

' ---------- Drawing ----------

function tourClamp(v as float, lo as float, hi as float) as float
    if hi < lo then hi = lo
    if v < lo then return lo
    if v > hi then return hi
    return v
end function

function tourLayout(r as object, tw as float, th as float, W as float, H as float, prefer as string, arrow as float, margin as float) as object
    cx = (r.left + r.right) / 2
    cy = (r.top + r.bottom) / 2
    space = { top: r.top, bottom: H - r.bottom, left: r.left, right: W - r.right }
    sides = ["right", "left"]
    if space.left > space.right then sides = ["left", "right"]
    verts = ["top", "bottom"]
    if cy < H / 2 then verts = ["bottom", "top"]
    order = []
    if cy < H * 0.34 or cy > H * 0.66
        order.append(verts) : order.append(sides)
    else
        order.append(sides) : order.append(verts)
    end if
    if prefer = "top" or prefer = "bottom" or prefer = "left" or prefer = "right"
        rest = []
        for each s in order
            if s <> prefer then rest.push(s)
        end for
        order = [prefer]
        order.append(rest)
    end if
    minArrow = 40
    side = ""
    reach = arrow
    for each s in order
        need = th
        if s = "left" or s = "right" then need = tw
        if side = "" and space[s] >= need + arrow + margin then side = s
    end for
    if side = ""
        for each s in order
            need = th
            if s = "left" or s = "right" then need = tw
            if side = "" and space[s] >= need + minArrow + margin
                side = s
                reach = space[s] - need - margin
                if reach > arrow then reach = arrow
                if reach < minArrow then reach = minArrow
            end if
        end for
    end if
    lit = { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    if side = ""
        ' No room around it: light up only the part that leaves room for the tooltip and arrow.
        side = verts[0]
        reach = minArrow
        if side = "bottom"
            lit.bottom = H - th - reach - margin
            if lit.bottom < lit.top + 40 then lit.bottom = lit.top + 40
        else
            lit.top = th + reach + margin
            if lit.top > lit.bottom - 40 then lit.bottom = lit.top + 40
        end if
    end if
    lcx = (lit.left + lit.right) / 2
    lcy = (lit.top + lit.bottom) / 2
    out = { side: side, reach: reach, lit: lit }
    if side = "bottom" or side = "top"
        out.x = tourClamp(lcx - tw / 2, margin, W - tw - margin)
        if side = "bottom" then out.y = lit.bottom + reach else out.y = lit.top - reach - th
        rr = (lit.right - lit.left) / 2
        if rr > 20 then rr = 20
        px = tourClamp(tourClamp(lcx, out.x + 40, out.x + tw - 40), lit.left + rr, lit.right - rr)
        out.tipX = px
        if side = "bottom" then out.tipY = lit.bottom else out.tipY = lit.top
    else
        out.y = tourClamp(lcy - th / 2, margin, H - th - margin)
        if side = "right" then out.x = lit.right + reach else out.x = lit.left - reach - tw
        rr = (lit.bottom - lit.top) / 2
        if rr > 20 then rr = 20
        py = tourClamp(tourClamp(lcy, out.y + 40, out.y + th - 40), lit.top + rr, lit.bottom - rr)
        out.tipY = py
        if side = "right" then out.tipX = lit.right else out.tipX = lit.left
    end if
    return out
end function

sub tourShowStep(stp as object, box as dynamic)
    cfg = tourSettings()
    W = 1280 : H = 720
    centered = (stp.center = true)
    tw = cfg.width
    if centered then tw = cfg.welcomeWidth
    pad = 28
    inner = tw - 2 * pad

    ' Words
    m.tipTitle.width = inner : m.tipTitle.text = stp.title
    m.tipText.width = inner : m.tipText.text = stp.text
    align = "left"
    if centered then align = "center"
    m.tipTitle.horizAlign = align : m.tipText.horizAlign = align
    titleH = m.tipTitle.boundingRect().height
    textH = m.tipText.boundingRect().height
    m.tipTitle.translation = [pad, pad - 4]
    m.tipText.translation = [pad, pad + titleH + 6]
    dotsY = pad + titleH + 6 + textH + 22
    btnY = dotsY + 30

    ' Progress dots
    m.tipDots.removeChildren(m.tipDots.getChildren(-1, 0))
    n = m.tourSteps.count()
    dw = (n - 1) * 24 + 36
    x = 0
    if centered then x = (tw - dw) / 2 else x = pad
    m.tipDots.translation = [x, dotsY]
    dx = 0
    for i = 0 to n - 1
        d = CreateObject("roSGNode", "Rectangle")
        d.height = 12 : d.width = 12 : d.translation = [dx, 0] : d.color = "0x3A4777FF"
        if i = m.tourIdx then d.width = 36 : d.color = "0x4F7BFFFF"
        m.tipDots.appendChild(d)
        if i = m.tourIdx then dx = dx + 36 + 12 else dx = dx + 12 + 12
    end for

    ' Buttons: Skip, Back, Next ("Start watching" on the last step)
    m.tipButtons.removeChildren(m.tipButtons.getChildren(-1, 0))
    m.tourBtns = []
    last = (m.tourIdx = n - 1)
    labels = []
    if not last then m.tourBtns.push("skip") : labels.push("Skip")
    if m.tourIdx > 0 then m.tourBtns.push("back") : labels.push("Back")
    m.tourBtns.push("next")
    if last then labels.push("Start watching") else labels.push("Next")
    for each label in labels
        b = CreateObject("roSGNode", "Button")
        b.text = label : b.minWidth = 150 : b.maxWidth = 300
        b.color = "0xFFFFFFFF" : b.focusedColor = "0x05081AFF"
        b.textColor = "0xDDE2F2FF" : b.focusedTextColor = "0x05081AFF"
        m.tipButtons.appendChild(b)
    end for
    if centered
        m.tipButtons.horizAlignment = "center" : m.tipButtons.translation = [tw / 2, btnY]
    else
        m.tipButtons.horizAlignment = "left" : m.tipButtons.translation = [pad, btnY]
    end if
    th = btnY + 72 + pad

    m.tipBg.width = tw - 4 : m.tipBg.height = th - 4 : m.tipBg.translation = [2, 2]
    m.tipEdge.width = tw : m.tipEdge.height = th
    m.tipAccent.width = tw : m.tipAccent.height = 5

    if box = invalid
        ' The welcome card: dimmed screen, a card in the middle, no spotlight and no arrow.
        m.tdimT.translation = [0, 0] : m.tdimT.width = W : m.tdimT.height = H
        for each id in ["tdimB", "tdimL", "tdimR"]
            m[id].width = 0 : m[id].height = 0
        end for
        for each id in ["tringT", "tringB", "tringL", "tringR", "tourArrow"]
            m[id].visible = false
        end for
        m.tourBob.control = "stop"
        m.tourTip.translation = [(W - tw) / 2, (H - th) / 2]
    else
        pd = cfg.padding
        if stp.padding <> invalid then pd = stp.padding
        lit = { left: tourClamp(box.left - pd, 6, W), top: tourClamp(box.top - pd, 6, H), right: tourClamp(box.right + pd, 0, W - 6), bottom: tourClamp(box.bottom + pd, 0, H - 6) }
        prefer = "auto"
        if stp.placement <> invalid then prefer = stp.placement
        L = tourLayout(lit, tw, th, W, H, prefer, cfg.arrow, cfg.margin)
        g = L.lit
        m.tourTip.translation = [L.x, L.y]
        ' Four rectangles dim everything but the lit box.
        m.tdimT.translation = [0, 0] : m.tdimT.width = W : m.tdimT.height = g.top
        m.tdimB.translation = [0, g.bottom] : m.tdimB.width = W : m.tdimB.height = H - g.bottom
        m.tdimL.translation = [0, g.top] : m.tdimL.width = g.left : m.tdimL.height = g.bottom - g.top
        m.tdimR.translation = [g.right, g.top] : m.tdimR.width = W - g.right : m.tdimR.height = g.bottom - g.top
        ' The outline, in Aurora's gradient.
        e = 4
        m.tringT.translation = [g.left, g.top] : m.tringT.width = g.right - g.left : m.tringT.height = e
        m.tringB.translation = [g.left, g.bottom - e] : m.tringB.width = g.right - g.left : m.tringB.height = e
        m.tringL.translation = [g.left, g.top] : m.tringL.width = e : m.tringL.height = g.bottom - g.top
        m.tringR.translation = [g.right - e, g.top] : m.tringR.width = e : m.tringR.height = g.bottom - g.top
        for each id in ["tringT", "tringB", "tringL", "tringR"]
            m[id].visible = true
        end for
        ' The arrow: its tip touches the lit box's edge, its tail meets the tooltip. It points toward the target.
        aw = 56 : reach = L.reach
        away = [0, 0]
        if L.side = "bottom"
            m.tourArrow.uri = "pkg:/images/tour_arrow_up.png"
            m.tourArrow.width = aw : m.tourArrow.height = reach : m.tourArrow.translation = [L.tipX - aw / 2, L.tipY]
            away = [0, 10]
        else if L.side = "top"
            m.tourArrow.uri = "pkg:/images/tour_arrow_down.png"
            m.tourArrow.width = aw : m.tourArrow.height = reach : m.tourArrow.translation = [L.tipX - aw / 2, L.tipY - reach]
            away = [0, -10]
        else if L.side = "right"
            m.tourArrow.uri = "pkg:/images/tour_arrow_left.png"
            m.tourArrow.width = reach : m.tourArrow.height = aw : m.tourArrow.translation = [L.tipX, L.tipY - aw / 2]
            away = [10, 0]
        else
            m.tourArrow.uri = "pkg:/images/tour_arrow_right.png"
            m.tourArrow.width = reach : m.tourArrow.height = aw : m.tourArrow.translation = [L.tipX - reach, L.tipY - aw / 2]
            away = [-10, 0]
        end if
        m.tourArrow.visible = true
        ' A gentle bounce away from the target and back, so the tip rests on its edge.
        m.tourBob.control = "stop"
        if cfg.animate
            home = m.tourArrow.translation
            m.tourBobI.keyValue = [home, [home[0] + away[0], home[1] + away[1]], home]
            m.tourBob.control = "start"
        end if
    end if

    m.tourView.visible = true
    f = m.tourBtns.count() - 1
    m.tipButtons.focusButton = f
    m.tipButtons.setFocus(true)
end sub
