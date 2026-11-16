sub init()
    m.top.functionName = "doRequest"
end sub

' One web request. The answer comes back in "result": the status code (0 when nothing answered) and the text.
sub doRequest()
    req = CreateObject("roUrlTransfer")
    port = CreateObject("roMessagePort")
    req.SetMessagePort(port)
    req.SetCertificatesFile("common:/certs/ca-bundle.crt")
    req.InitClientCertificates()
    req.RetainBodyOnError(true)
    req.EnableEncodings(true)
    req.SetUrl(m.top.url)
    hdr = m.top.headers
    if hdr <> invalid
        for each k in hdr
            req.AddHeader(k, hdr[k])
        end for
    end if
    started = false
    if m.top.method = "POST"
        req.AddHeader("Content-Type", "application/json")
        started = req.AsyncPostFromString(m.top.body)
    else
        started = req.AsyncGetToString()
    end if
    result = { status: 0, body: "" }
    if started
        msg = wait(45000, port)
        if type(msg) = "roUrlEvent"
            result = { status: msg.GetResponseCode(), body: msg.GetString() }
        else
            req.AsyncCancel()
        end if
    end if
    m.top.result = result
end sub
