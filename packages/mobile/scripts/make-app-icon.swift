// Builds the iOS app icon: dorabot's robot (from /Applications/dorabot.app icon.icns, exported
// to PNG with sips) flattened onto navy, plus a green "remote" signal badge.
// Usage: swift make-app-icon.swift <robot-1024.png> <out.png>
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil)!
let robot = CGImageSourceCreateImageAtIndex(src, 0, nil)!
let S = 1024
let cs = CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CGContext(data: nil, width: S, height: S, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
// Opaque navy base sampled from the source edge colour, then the robot on top.
ctx.setFillColor(CGColor(srgbRed: 0.106, green: 0.157, blue: 0.282, alpha: 1))
ctx.fill(CGRect(x: 0, y: 0, width: S, height: S))
ctx.draw(robot, in: CGRect(x: 0, y: 0, width: S, height: S))

// Badge: bottom-right circle (CG origin is bottom-left).
let r: CGFloat = 125, cx: CGFloat = 1024 - 85 - r, cy: CGFloat = 85 + r
ctx.setFillColor(CGColor(srgbRed: 0.106, green: 0.157, blue: 0.282, alpha: 1))   // navy ring
ctx.fillEllipse(in: CGRect(x: cx - r - 18, y: cy - r - 18, width: 2 * (r + 18), height: 2 * (r + 18)))
ctx.setFillColor(CGColor(srgbRed: 0.431, green: 0.906, blue: 0.659, alpha: 1))   // app green
ctx.fillEllipse(in: CGRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r))

// Signal waves: dot + three arcs opening upward-right, in navy.
let ink = CGColor(srgbRed: 0.059, green: 0.090, blue: 0.165, alpha: 1)
let ox = cx - 42, oy = cy - 42
ctx.setFillColor(ink)
ctx.fillEllipse(in: CGRect(x: ox - 19, y: oy - 19, width: 38, height: 38))
ctx.setStrokeColor(ink)
ctx.setLineWidth(22)
ctx.setLineCap(.round)
for rad in [CGFloat(58), 98, 138] {
  ctx.addArc(center: CGPoint(x: ox, y: oy), radius: rad, startAngle: 0.05 * .pi, endAngle: 0.45 * .pi, clockwise: false)
  ctx.strokePath()
}
let out = ctx.makeImage()!
let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, out, nil)
CGImageDestinationFinalize(dest)
