// --- CRITICAL NODE 24 / TENSORFLOW POLYNOMIAL HOTFIX ---
const util = require('util');
if (!util.isNullOrUndefined) {
  util.isNullOrUndefined = (value) => value === undefined || value === null;
}
// ------------------------------------------------------

const fs = require('fs');
const path = require('path');
const tf = require('@tensorflow/tfjs-node');
const Upscaler = require('upscaler/node');
const defaultModel = require('@upscalerjs/default-model');

const INPUT_DIR = './input_images';
const OUTPUT_DIR = './output_images';

// Recursively look for images inside the extracted structure
function getImages(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const files = fs.readdirSync(dir);
  
  files.forEach(file => {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      getImages(filePath, fileList);
    } else {
      const ext = path.extname(file).toLowerCase();
      if (['.png', '.jpg', '.jpeg'].includes(ext)) {
        fileList.push(filePath);
      }
    }
  });
  return fileList;
}

async function main() {
  try {
    const images = getImages(INPUT_DIR);

    if (images.length === 0) {
      console.error("No valid images found in the extracted zip folder.");
      process.exit(1);
    }

    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR);
    }

    console.log(`Initializing model engine... Found ${images.length} target images.`);
    const upscaler = new Upscaler({ model: defaultModel });

    for (let i = 0; i < images.length; i++) {
      const imagePath = images[i];
      const baseName = path.basename(imagePath, path.extname(imagePath));
      
      // Force output extension to always be .jpg
      const outputPath = path.join(OUTPUT_DIR, `${baseName}_upscaled.jpg`);
      
      console.log(`[${i + 1}/${images.length}] Processing: ${path.basename(imagePath)} -> Converting to JPG`);

      const imageBuffer = fs.readFileSync(imagePath);
      const imageTensor = tf.node.decodeImage(imageBuffer, 3);

      // Run Upscale operation
      const upscaledTensor = await upscaler.upscale(imageTensor);
      
      // Change encoding format to JPEG (quality parameter ranges from 0 to 100)
      const outputBuffer = await tf.node.encodeJpeg(upscaledTensor, 95);

      fs.writeFileSync(outputPath, outputBuffer);
      console.log(`   Saved -> ${outputPath}`);

      // Free system memory tensors
      imageTensor.dispose();
      upscaledTensor.dispose();
    }

    console.log("All operations completed successfully!");

  } catch (error) {
    console.error("Batch engine processing failed:", error);
    process.exit(1);
  }
}

main();
