#import <AppKit/AppKit.h>

static NSInteger canvasHeight;
static NSRect topRect(NSInteger x, NSInteger top, NSInteger width, NSInteger height) {
    return NSMakeRect(x, canvasHeight - top - height, width, height);
}
static void drawText(NSString *value, NSInteger x, NSInteger top, NSInteger width, NSInteger height, CGFloat size, BOOL bold, NSColor *color) {
    NSFont *font = bold ? [NSFont boldSystemFontOfSize:size] : [NSFont systemFontOfSize:size];
    [value drawInRect:topRect(x, top, width, height) withAttributes:@{NSFontAttributeName: font, NSForegroundColorAttributeName: color}];
}
static void fillCard(NSRect bounds, NSColor *color, CGFloat radius) {
    [color setFill];
    [[NSBezierPath bezierPathWithRoundedRect:bounds xRadius:radius yRadius:radius] fill];
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 4) { fprintf(stderr, "usage: make-construction-trays manifest.json source-dir output.png\n"); return 2; }
        NSData *manifest = [NSData dataWithContentsOfFile:@(argv[1])];
        NSArray<NSDictionary *> *pages = [NSJSONSerialization JSONObjectWithData:manifest options:0 error:NULL];
        if (pages.count != 10) { fprintf(stderr, "Expected ten guide pages\n"); return 2; }
        NSString *source = @(argv[2]);
        NSString *output = @(argv[3]);
        NSString *cropDirectory = [[output stringByDeletingLastPathComponent] stringByAppendingPathComponent:@"trays"];
        if (![[NSFileManager defaultManager] createDirectoryAtPath:cropDirectory withIntermediateDirectories:YES attributes:nil error:NULL]) return 2;
        NSInteger cardWidth = 920, cardHeight = 526, gap = 24, margin = 24, headerHeight = 76, footerHeight = 36;
        NSInteger width = margin * 2 + 2 * cardWidth + gap;
        canvasHeight = headerHeight + 5 * cardHeight + 4 * gap + footerHeight;
        NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:width pixelsHigh:canvasHeight bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
        if (!bitmap) return 2;
        NSGraphicsContext *context = [NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap];
        [NSGraphicsContext saveGraphicsState];
        [NSGraphicsContext setCurrentContext:context];
        [[NSColor colorWithCalibratedRed:0.09 green:0.12 blue:0.12 alpha:1] setFill];
        NSRectFill(NSMakeRect(0, 0, width, canvasHeight));
        drawText(@"Stronghold Crusader DE · Construction controls", margin, 17, width - margin * 2, 36, 30, YES, NSColor.whiteColor);
        drawText(@"Historical menu guide · Steam build 24816905 · Numbers match the red boxes on each exact game crop", margin, 53, width - margin * 2, 24, 17, NO, [NSColor colorWithWhite:0.79 alpha:1]);
        for (NSInteger index = 0; index < pages.count; index++) {
            NSDictionary *page = pages[index];
            NSInteger col = index % 2, row = index / 2;
            NSInteger cardX = margin + col * (cardWidth + gap);
            NSInteger cardTop = headerHeight + row * (cardHeight + gap);
            fillCard(topRect(cardX, cardTop, cardWidth, cardHeight), [NSColor colorWithCalibratedRed:0.14 green:0.18 blue:0.17 alpha:1], 12);
            NSString *title = [NSString stringWithFormat:@"%ld. %@", (long)index + 1, page[@"title"]];
            drawText(title, cardX + 18, cardTop + 12, cardWidth - 36, 32, 25, YES, NSColor.whiteColor);
            NSString *file = [source stringByAppendingPathComponent:page[@"file"]];
            NSBitmapImageRep *sourceRep = [[NSBitmapImageRep alloc] initWithData:[NSData dataWithContentsOfFile:file]];
            if (!sourceRep || sourceRep.pixelsWide != 2620 || sourceRep.pixelsHigh != 1080) {
                fprintf(stderr, "Missing or unexpected source PNG: %s\n", file.UTF8String); return 2;
            }
            NSImage *image = [[NSImage alloc] initWithSize:NSMakeSize(2620, 1080)];
            [image addRepresentation:sourceRep];
            NSBitmapImageRep *cropBitmap = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:780 pixelsHigh:230 bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
            NSGraphicsContext *cropContext = [NSGraphicsContext graphicsContextWithBitmapImageRep:cropBitmap];
            [NSGraphicsContext saveGraphicsState];
            [NSGraphicsContext setCurrentContext:cropContext];
            [image drawInRect:NSMakeRect(0, 0, 780, 230) fromRect:NSMakeRect(795, 0, 780, 230) operation:NSCompositingOperationCopy fraction:1];
            [cropContext flushGraphics];
            [NSGraphicsContext restoreGraphicsState];
            NSString *cropPath = [cropDirectory stringByAppendingPathComponent:page[@"file"]];
            if (![[cropBitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:cropPath atomically:YES]) return 2;
            // The red outline contains the construction tray only. NSImage source coordinates start at the bottom left.
            [image drawInRect:topRect(cardX + (cardWidth - 780) / 2, cardTop + 47, 780, 230)
                  fromRect:NSMakeRect(795, 0, 780, 230)
                 operation:NSCompositingOperationCopy fraction:1];
            NSArray<NSDictionary *> *labels = page[@"labels"];
            NSInteger leftCount = (labels.count + 1) / 2;
            NSInteger labelColumnWidth = (cardWidth - 50) / 2;
            for (NSInteger labelIndex = 0; labelIndex < labels.count; labelIndex++) {
                NSDictionary *label = labels[labelIndex];
                NSInteger labelCol = labelIndex < leftCount ? 0 : 1;
                NSInteger labelRow = labelCol ? labelIndex - leftCount : labelIndex;
                NSInteger labelX = cardX + 18 + labelCol * (labelColumnWidth + 14);
                NSInteger itemTop = cardTop + 288 + labelRow * 43;
                drawText([NSString stringWithFormat:@"%ld. %@", (long)labelIndex + 1, label[@"name"]], labelX, itemTop, labelColumnWidth, 22, 16, YES, [NSColor colorWithCalibratedRed:1 green:0.78 blue:0.72 alpha:1]);
                drawText(label[@"detail"], labelX + 18, itemTop + 20, labelColumnWidth - 18, 38, 13, NO, [NSColor colorWithWhite:0.84 alpha:1]);
            }
        }
        drawText(@"Reference only. Use the live screenshot and tooltip for availability, position and price.", margin, canvasHeight - footerHeight + 8, width - margin * 2, 25, 17, NO, [NSColor colorWithWhite:0.82 alpha:1]);
        [context flushGraphics];
        [NSGraphicsContext restoreGraphicsState];
        NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        if (![png writeToFile:output atomically:YES]) return 2;
        return 0;
    }
}
