const fs = require('fs');
const tf = require('@tensorflow/tfjs-node');
const Upscaler = require('upscaler/node');
const defaultModel = require('@upscalerjs/default-model');

async function main() {
  try {
    // Looks for input.png first, falls back to input.jpg extracted from the zip
    let inputPath = './input.png';
    if (!fs.existsSync(inputPath)) {
      inputPath = './input.jpg';
    }

    if (!fs.existsSync(inputPath)) {
      console.error("Error: Could not find extracted image target (input.png or input.jpg) in root.");
      process.exit(1);
    }

    console.log(`Loading model and source file: ${inputPath}...`);
    const upscaler = new Upscaler({
      model: defaultModel
    });

    // 1. Read input image buffer
    const imageBuffer = fs.readFileSync(inputPath);
    
    // 2. Decode automatically into raw pixel values tensor layout
    const imageTensor = tf.node.decodeImage(imageBuffer, 3);

    console.log("Upscaling image using CPU layer execution backend...");
    const upscaledTensor = await upscaler.upscale(imageTensor);

    // 3. Encode the output back into PNG format
    const outputBuffer = await tf.node.encodePng(upscaledTensor);

    // 4. Write back to disk workspace root folder layout
    fs.writeFileSync('./output.png', outputBuffer);
    console.log("Success! Extracted target saved cleanly as output.png");

    // Clean up memory allocations
    imageTensor.dispose();
    upscaledTensor.dispose();

  } catch (error) {
    console.error("Processing pipeline crashed:", error);
    process.exit(1);
  }
}

main();
