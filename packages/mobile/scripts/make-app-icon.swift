// Builds the iOS app icon: dorabot's robot scaled up 15% on navy background,
// with a white Wi-Fi symbol in the top-right corner.
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
// Opaque navy base, then draw robot scaled up 1.15x around the canvas center.
ctx.setFillColor(CGColor(srgbRed: 0.106, green: 0.157, blue: 0.282, alpha: 1))
ctx.fill(CGRect(x: 0, y: 0, width: S, height: S))
let scaledSize = CGFloat(S) * 1.15  // 1178 px
let origin = (CGFloat(S) - scaledSize) / 2  // -77 on both axes
ctx.draw(robot, in: CGRect(x: origin, y: origin, width: scaledSize, height: scaledSize))

// Wi-Fi symbol: white solid shapes in top-right corner.
let wifiCenter = CGPoint(x: 800, y: 700)
ctx.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))  // white

// Filled dot at the apex
ctx.fillEllipse(in: CGRect(x: wifiCenter.x - 26, y: wifiCenter.y - 26, width: 52, height: 52))

// Three solid annular sector bands (arc bands) opening upward
let bands = [(inner: CGFloat(62), outer: CGFloat(98)),
             (inner: CGFloat(128), outer: CGFloat(164)),
             (inner: CGFloat(194), outer: CGFloat(230))]
let startAngle = CGFloat.pi * 0.25      // 45 degrees (northeast)
let endAngle = CGFloat.pi * 0.75        // 135 degrees (northwest)

for band in bands {
  ctx.beginPath()
  ctx.addArc(center: wifiCenter, radius: band.outer, startAngle: startAngle, endAngle: endAngle, clockwise: false)
  ctx.addArc(center: wifiCenter, radius: band.inner, startAngle: endAngle, endAngle: startAngle, clockwise: true)
  ctx.closePath()
  ctx.fillPath()
}
let out = ctx.makeImage()!
let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, out, nil)
CGImageDestinationFinalize(dest)
