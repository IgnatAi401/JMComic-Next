import { crypto } from "../../api/Crypto.js";

export class ImageCutter {
    constructor() {}
    cutImage(image, id, path) {
        const width = image.naturalWidth;
        const height = image.naturalHeight;
        if (!width || !height) throw new Error("图片尺寸无效，无法还原");
        if (width > 16384) throw new Error("图片宽度超过 Safari 可安全处理的范围");

        const fragment = document.createDocumentFragment();
        const sliceCount = this.#getCuttingCount(id, path.substring(0,5));
        const sliceHeight = Math.floor(height / sliceCount);
        const remainingHeight = height % sliceCount;
        const canvases = [];

        const appendSlice = (sourceY, outputHeight) => {
            const canvas = document.createElement("canvas");
            canvases.push(canvas);
            canvas.width = width;
            canvas.height = outputHeight;
            const context = canvas.getContext("2d", { alpha: false });
            if (!context) throw new Error("浏览器无法创建图片画布");
            context.drawImage(image, 0, sourceY, width, outputHeight, 0, 0, width, outputHeight);
            fragment.append(canvas);
        };

        try {
            appendSlice(height - sliceHeight - remainingHeight, sliceHeight + remainingHeight);
            for (let i = 0; i < sliceCount - 1; i++) {
                appendSlice(sliceHeight * (sliceCount - i - 2), sliceHeight);
            }
            return fragment;
        } catch (error) {
            // Detached canvases still retain their backing stores in WebKit.
            // Include the current slice even if context creation or drawing failed.
            canvases.forEach((canvas) => {
                canvas.width = 0;
                canvas.height = 0;
            });
            throw error;
        }
    }
    #getCuttingCount(id, path) {
        if (id >= 220980 && id < 268850) {
            return 10;
        }
        const hashData = crypto.calculateMD5(id + path);
        let key = hashData.charCodeAt(hashData.length - 1);
        if (id >= 268850 && id <= 421925) {
            key = key % 10;
        } else {
            key = key % 8;
        }
        if (key >= 0 && key <= 9) {
            return key * 2 + 2;
        } else {
            return 10;
        }
    }
}
