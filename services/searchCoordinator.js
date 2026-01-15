const fs = require('fs').promises;
const path = require('path');
const { PDFDocument } = require('pdf-lib');

class SearchCoordinator {
    constructor() {
        this.baseDownloadDir = path.join(__dirname, '..', 'downloads');
    }

    // 创建搜索会话文件夹结构
    async createSearchSession(userRequirements) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);

        // 从用户条件中提取关键词作为文件夹名称
        const keywords = this.extractKeywords(userRequirements);
        const sessionName = `search_${timestamp}_${keywords}`;

        const sessionPath = path.join(this.baseDownloadDir, sessionName);

        // 创建主文件夹和三个子文件夹
        const folders = [
            sessionPath,
            path.join(sessionPath, 'atbb'),
            path.join(sessionPath, 'itandi'),
            path.join(sessionPath, 'ierube_bb')
        ];

        for (const folder of folders) {
            await fs.mkdir(folder, { recursive: true });
            console.log(`[Coordinator] 创建文件夹: ${folder}`);
        }

        return {
            sessionPath,
            sessionName,
            folders: {
                atbb: path.join(sessionPath, 'atbb'),
                itandi: path.join(sessionPath, 'itandi'),
                ierube_bb: path.join(sessionPath, 'ierube_bb')
            }
        };
    }

    // 从用户条件中提取关键词
    extractKeywords(requirements) {
        // 提取地名、间取り等关键信息
        const cleaned = requirements
            .replace(/\s+/g, '_')
            .replace(/[^\w\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/g, '')
            .substring(0, 30);

        return cleaned || 'search';
    }

    // 下载PDF到指定平台文件夹
    async downloadPDF(platform, pdfUrl, sessionFolders) {
        const platformFolder = sessionFolders[platform.toLowerCase()];
        if (!platformFolder) {
            throw new Error(`Unknown platform: ${platform}`);
        }

        const filename = `property_${Date.now()}.pdf`;
        const filepath = path.join(platformFolder, filename);

        console.log(`[Coordinator] 下载PDF: ${platform} -> ${filepath}`);

        // 这里需要实际的PDF下载逻辑
        // 暂时创建占位文件
        await fs.writeFile(filepath, `PDF from ${platform}: ${pdfUrl}`);

        return filepath;
    }

    // 合并PDF和图片文件为一个PDF
    async mergePDFs(platform, sessionFolders) {
        const platformFolder = sessionFolders[platform.toLowerCase()];
        if (!platformFolder) {
            throw new Error(`Unknown platform: ${platform}`);
        }

        console.log(`[Coordinator] 合并文件: ${platform}`);

        // 读取文件夹中的所有PDF和图片文件
        const files = await fs.readdir(platformFolder);
        const pdfFiles = files.filter(f => f.endsWith('.pdf') && !f.includes('merged'));
        const imageFiles = files.filter(f =>
            f.toLowerCase().endsWith('.png') ||
            f.toLowerCase().endsWith('.jpg') ||
            f.toLowerCase().endsWith('.jpeg')
        );

        const totalFiles = pdfFiles.length + imageFiles.length;

        if (totalFiles === 0) {
            console.log(`[Coordinator] ${platform}: 没有文件需要合并`);
            return null;
        }

        console.log(`[Coordinator] ${platform}: 找到 ${pdfFiles.length} 个PDF, ${imageFiles.length} 个图片`);

        // 如果只有一个PDF且没有图片，直接返回该文件路径
        if (pdfFiles.length === 1 && imageFiles.length === 0) {
            const singlePdfPath = path.join(platformFolder, pdfFiles[0]);
            console.log(`[Coordinator] ${platform}: 只有一个PDF，无需合并: ${singlePdfPath}`);
            return singlePdfPath;
        }

        const mergedFilename = `${platform}_merged_${Date.now()}.pdf`;
        const mergedPath = path.join(platformFolder, mergedFilename);

        try {
            // 创建新的PDF文档
            const mergedPdf = await PDFDocument.create();

            // 先处理PDF文件
            for (const pdfFile of pdfFiles) {
                const pdfPath = path.join(platformFolder, pdfFile);
                console.log(`[Coordinator] 读取PDF: ${pdfFile}`);

                try {
                    const pdfBytes = await fs.readFile(pdfPath);
                    const sourcePdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });

                    // 复制所有页面到合并后的PDF
                    const pages = await mergedPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
                    pages.forEach(page => mergedPdf.addPage(page));

                    console.log(`[Coordinator] 合并了 ${pages.length} 页从 ${pdfFile}`);
                } catch (pdfError) {
                    console.error(`[Coordinator] 读取PDF失败 ${pdfFile}:`, pdfError.message);
                }
            }

            // 再处理图片文件
            for (const imageFile of imageFiles) {
                const imagePath = path.join(platformFolder, imageFile);
                console.log(`[Coordinator] 读取图片: ${imageFile}`);

                try {
                    const imageBytes = await fs.readFile(imagePath);
                    let image;

                    // 根据文件类型嵌入图片
                    if (imageFile.toLowerCase().endsWith('.png')) {
                        image = await mergedPdf.embedPng(imageBytes);
                    } else {
                        image = await mergedPdf.embedJpg(imageBytes);
                    }

                    // 创建与图片大小匹配的页面
                    const page = mergedPdf.addPage([image.width, image.height]);
                    page.drawImage(image, {
                        x: 0,
                        y: 0,
                        width: image.width,
                        height: image.height
                    });

                    console.log(`[Coordinator] 添加图片页面: ${imageFile} (${image.width}x${image.height})`);
                } catch (imageError) {
                    console.error(`[Coordinator] 读取图片失败 ${imageFile}:`, imageError.message);
                }
            }

            // 保存合并后的PDF
            const mergedPdfBytes = await mergedPdf.save();
            await fs.writeFile(mergedPath, mergedPdfBytes);

            console.log(`[Coordinator] 文件合并完成: ${mergedPath} (共${mergedPdf.getPageCount()}页)`);
            return mergedPath;

        } catch (error) {
            console.error(`[Coordinator] 文件合并失败:`, error.message);
            // 如果合并失败，返回第一个PDF（如果有的话）
            if (pdfFiles.length > 0) {
                return path.join(platformFolder, pdfFiles[0]);
            }
            return null;
        }
    }

    // 完整搜索流程协调
    async coordinateSearch(userRequirements, tantousha, searchResults, existingSession = null) {
        console.log('[Coordinator] 开始协调搜索会话...');

        // 1. 使用现有会话或创建新的文件夹结构
        const session = existingSession || await this.createSearchSession(userRequirements);

        // 2. 保存搜索条件
        const conditionsFile = path.join(session.sessionPath, 'search_conditions.json');
        await fs.writeFile(conditionsFile, JSON.stringify({
            userRequirements,
            tantousha,
            timestamp: new Date().toISOString(),
            platforms: ['ATBB', 'ITANDI', 'いえらぶBB']
        }, null, 2));

        // 3. 处理各平台结果
        const platformResults = {
            atbb: null,
            itandi: null,
            ierube_bb: null
        };

        // ATBB
        if (searchResults.atbb && searchResults.atbb.success) {
            try {
                // 这里应该从浏览器下载PDF
                // 暂时跳过实际下载，直接合并
                platformResults.atbb = await this.mergePDFs('atbb', session.folders);
            } catch (error) {
                console.error('[Coordinator] ATBB PDF处理失败:', error.message);
            }
        }

        // ITANDI
        if (searchResults.itandi && searchResults.itandi.success) {
            try {
                platformResults.itandi = await this.mergePDFs('itandi', session.folders);
            } catch (error) {
                console.error('[Coordinator] ITANDI PDF处理失败:', error.message);
            }
        }

        // いえらぶBB
        if (searchResults.ierube_bb && searchResults.ierube_bb.success) {
            try {
                platformResults.ierube_bb = await this.mergePDFs('ierube_bb', session.folders);
            } catch (error) {
                console.error('[Coordinator] いえらぶBB PDF处理失败:', error.message);
            }
        }

        // 4. 保存结果摘要
        const summaryFile = path.join(session.sessionPath, 'results_summary.json');
        await fs.writeFile(summaryFile, JSON.stringify({
            session: session.sessionName,
            created: new Date().toISOString(),
            userRequirements,
            tantousha,
            platforms: {
                atbb: {
                    success: searchResults.atbb?.success || false,
                    mergedPdf: platformResults.atbb,
                    url: searchResults.atbb?.resultUrl
                },
                itandi: {
                    success: searchResults.itandi?.success || false,
                    mergedPdf: platformResults.itandi,
                    url: searchResults.itandi?.resultUrl
                },
                ierube_bb: {
                    success: searchResults.ierube_bb?.success || false,
                    mergedPdf: platformResults.ierube_bb,
                    url: searchResults.ierube_bb?.resultUrl
                }
            }
        }, null, 2));

        console.log('[Coordinator] 搜索会话协调完成');

        return {
            sessionPath: session.sessionPath,
            sessionName: session.sessionName,
            folders: session.folders,
            mergedPdfs: platformResults,
            summaryFile,
            conditionsFile
        };
    }

    // 获取搜索历史
    async getSearchHistory() {
        try {
            const sessions = await fs.readdir(this.baseDownloadDir);
            const history = [];

            for (const sessionName of sessions) {
                const sessionPath = path.join(this.baseDownloadDir, sessionName);
                const stats = await fs.stat(sessionPath);

                if (stats.isDirectory()) {
                    const summaryPath = path.join(sessionPath, 'results_summary.json');
                    try {
                        const summary = JSON.parse(await fs.readFile(summaryPath, 'utf-8'));
                        history.push({
                            sessionName,
                            created: summary.created,
                            userRequirements: summary.userRequirements,
                            platforms: summary.platforms
                        });
                    } catch (e) {
                        // 忽略没有摘要的会话
                    }
                }
            }

            return history.sort((a, b) => new Date(b.created) - new Date(a.created));
        } catch (error) {
            console.error('[Coordinator] 获取搜索历史失败:', error.message);
            return [];
        }
    }
}

module.exports = new SearchCoordinator();
