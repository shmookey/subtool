import * as fs from 'node:fs/promises'
import { parseCommandLine } from './cli.js'
import * as dt from './dt.js'
import * as dump from './dump.js'
import { load_subfile, write_subfile } from './subfile.js'
import { print_header, parse_header, read_header, serialise_header, set_header_value } from './header.js'
import { read_section, initMetadata, read_block, write_section } from './util.js'
import type { Metadata, OutputDescriptor, SourceMap } from './types'
import { FileHandle } from 'node:fs/promises'


async function main(args: string[]) {
  const parseResult = parseCommandLine(args)
  if(parseResult.status != 'ok')
    return parseResult
  
  switch(parseResult.command) {
  case 'show':
    return runShow(parseResult.fixedArgs[0], parseResult.opts)
  case 'dt':
    return runDt(parseResult.fixedArgs[0], parseResult.opts)
  case 'info':
    return runInfo(parseResult.fixedArgs[0], parseResult.opts)
  case 'dump':
    return dump.runDump(parseResult.fixedArgs[0], parseResult.fixedArgs[1], parseResult.opts)
  case 'repoint':
    return runRepoint(parseResult.fixedArgs[0], parseResult.fixedArgs[1], parseResult.opts)
  case 'replace':
    return runReplace(parseResult.fixedArgs[0], parseResult.fixedArgs[1], parseResult.opts)
  case 'get':
    return runGet(parseResult.fixedArgs[0], parseResult.fixedArgs[1], parseResult.opts)
  case 'set':
    return runSet(parseResult.fixedArgs[0], parseResult.fixedArgs[1], parseResult.fixedArgs[2], parseResult.opts)
  case 'unset':
    return runUnset(parseResult.fixedArgs[0], parseResult.fixedArgs[1], parseResult.opts)
  case null:
    return {status: 'ok'}
  default:
    console.error(`${parseResult.command} is not implemented.`)
    break
  }
  return {status: 'ok'}
}

async function runGet(key: string, filename: string, opts) {
  const loadResult = await load_subfile(filename)
  if(loadResult.status != 'ok')
    return loadResult
  const {meta, file} = loadResult
  const headerResult: any = await read_header(file, meta)
  if(headerResult.status != 'ok')
    return headerResult
  const header = headerResult.header
  if(key in header)
    console.log(header[key])
  else
    console.log(`No such key: ${key}.`)

  await file.close()
  return {status: 'ok'}
}

async function runSet(key: string, value: string, filename: string, opts) {
  const loadResult = await load_subfile(filename, 'r+')
  if(loadResult.status != 'ok')
    return loadResult
  const {meta, file} = loadResult
  const headerResult: any = await read_header(file, meta)
  if(headerResult.status != 'ok')
    return headerResult

  const header = headerResult.header
  const setResult = set_header_value(key, value, header, opts.set_force)
  if(setResult.status != 'ok')
    return setResult

  const headerBuf = serialise_header(header, meta)
  const writeResult = await write_section('header', headerBuf, file, meta)
  if(writeResult.status != 'ok')
    return writeResult

  await file.close()
  return {status: 'ok'}
}

async function runUnset(key: string, filename: string, opts) {
  const loadResult = await load_subfile(filename, 'r+')
  if(loadResult.status != 'ok')
    return loadResult
  const {meta, file} = loadResult
  const headerResult: any = await read_header(file, meta)
  if(headerResult.status != 'ok')
    return headerResult

  const header = headerResult.header
  if(!(key in header || opts.unset_force)) {
    await file.close()
    return {status: 'err', reason: `No such key ${key}.`}
  } 

  delete header[key]

  const headerBuf = serialise_header(header, meta)
  const writeResult = await write_section('header', headerBuf, file, meta)
  if(writeResult.status != 'ok')
    return writeResult

  await file.close()
  return {status: 'ok'}
}

async function runShow(filename: string, opts) {
  const file: FileHandle = await fs.open(filename, 'r')
  const loadResult = await load_subfile(filename)
  if(loadResult.status != 'ok')
    return loadResult
  const meta = loadResult.meta

  // Read header
  // We always do this, even if we're not printing it, since everything else depends on it (except
  // when only printing the header in binary, but we're not optimising that special case).
  const headerBuf = new ArrayBuffer(4096)
  let result = await file.read(new Uint8Array(headerBuf), 0, 4096)
  if(result.bytesRead != 4096) throw `Failed to read header data. Expected to read 4096 bytes, got ${result.bytesRead}`
  const header = parse_header(headerBuf)
  if(opts.show_header) {
    console.log('Header section:')
    print_header(header, headerBuf, opts)
  }

  if(!(opts.show_delay_table || opts.show_data))
    return {status: 'ok'}

  // Read tile metadata
  console.log('')
  const delayTableLength = 20 + 2 * 1600
  const delayTablePad = 0 // 4 - delayTableLength % 4
  const delayTableSectionLength = (delayTableLength + delayTablePad) * header.NINPUTS
  const delayTableBuf = new ArrayBuffer(delayTableSectionLength)
  result = await file.read(new Uint8Array(delayTableBuf), 0, delayTableSectionLength)
  if(result.bytesRead != delayTableSectionLength)
    throw `Failed to read header data. Expected to read ${delayTableSectionLength} bytes, got ${result.bytesRead}`
  const tiles = []
  for(let i=0; i<header.NINPUTS; i++) {
    const view = new DataView(delayTableBuf, i*(delayTableLength+delayTablePad), delayTableLength)
    const tile = dt.parse_delay_table_row(view, meta)
    tiles.push(tile)
  }
  if(opts.show_delay_table)
    dt.print_delay_table(tiles, delayTableBuf, opts, meta)
  

  // Read voltages
  if(!opts.show_data) {
    await file.close()
    return {status: 'ok'}
  }
  const selected_ids = []
  if(opts.selected_sources != null) {
    for(let src of opts.selected_sources) {
      const idx = tiles.findIndex(tile => tile.rf_input == src)
      if(idx == -1) {
        console.warn(`Warning: source ${src} not found in file.`)
        continue
      }
      selected_ids.push(idx)
    }
  } else {
    for(let i=0; i<tiles.length; i++)
      selected_ids.push(i)
  }
  
  const dataBlockResult: any = await read_block(opts.show_block, file, meta)
  if(dataBlockResult.status != 'ok')
    return dataBlockResult
  console.log('\nVoltage data:')
  const dataBlock = new Int8Array(dataBlockResult.buf)
  const nSamples = Math.min(meta.samples_per_line, opts.num_samples)
  for(let i of selected_ids) {
    const xs = dataBlock.subarray(i*meta.sub_line_size, (i+1)*meta.sub_line_size)
    //let str = 
    process.stdout.write(`${tiles[i].rf_input.toString().padStart(4, ' ')} `)
    for(let j=0; j<nSamples; j++) {
      let [re, im] = [xs[j*2], xs[j*2+1]]
      let [reStr, imStr] = [`${re}`, im >= 0 ? `+${im}` : `${im}`]
      process.stdout.write(`${reStr}${imStr}i `.padStart(8, ' '))
    }
    process.stdout.write('\n')
    //console.log(str)
  }

  await file.close()

  return {status: 'ok'}
}

async function runDt(filename: string, opts) {
  const meta = initMetadata()
  meta.filename = filename
  meta.num_sources = opts.num_sources_in
  meta.num_frac_delays = opts.num_frac_delays_in
  const loadResult: any = await dt.load_delay_table(filename, opts, meta)
  if(loadResult.status != 'ok') {
    console.error(loadResult.reason)
    return
  }
  const table = loadResult.table
  if(opts.compare_file) {
    
    const loadCmpResult: any = await dt.load_delay_table(opts.compare_file, opts, meta)
    if(loadCmpResult.status != 'ok') {
      console.error(loadCmpResult.reason)
      return
    }
    
    const tableCmp = loadCmpResult.table
    const diffResult = dt.compare_delays(tableCmp, table)
    
    if(diffResult.status != 'ok') {
      console.log(diffResult.reason)
      return
    }
    dt.print_delay_table(diffResult.table, null, opts, meta)
    
  } else {
    dt.print_delay_table(table, loadResult.binaryBuffer, opts, meta)
  }

  return {status: 'ok'}
}

async function runInfo(filename, opts) {
  const loadResult = await load_subfile(filename)
  if(loadResult.status != 'ok') {
    console.error(loadResult.reason)
    return
  }
  const meta = loadResult.meta
  Object.entries(meta).forEach(([k, v]) => {
    console.log(`${k}: ${v}`)
  })

  return {status: 'ok'}
}


async function runRepoint(infilename, outfilename, opts) {
  const loadResult = await load_subfile(infilename)
  if(loadResult.status != 'ok') {
    console.error(loadResult.reason)
    return
  }
  const {file, meta} = loadResult

  const headerResult = await read_section('header', file, meta)
  const dtResult =     await read_section('dt', file, meta)
  const udpmapResult = await read_section('udpmap', file, meta)
  const marginResult = await read_section('margin', file, meta)
  if(headerResult.status != 'ok') return headerResult
  if(dtResult.status != 'ok') return dtResult
  if(udpmapResult.status != 'ok') return udpmapResult
  if(marginResult.status != 'ok') return marginResult

  const dtMeta = initMetadata()
  dtMeta.filename = opts.delay_table_filename
  const loadDtResult: any = await dt.load_delay_table(opts.delay_table_filename, {format_in: 'auto'}, dtMeta)
  if(loadDtResult.status != 'ok') {
    console.error(loadDtResult.reason)
    return
  }
  const origDtResult: any = dt.parse_delay_table_binary(dtResult.buf, meta)
  if(origDtResult.status != 'ok') {
    console.error(origDtResult.reason)
    return
  }
  const origDt = origDtResult.table
  const newDt = loadDtResult.table
  const newDtBin = dt.serialise_delay_table(newDt, meta.num_sources, meta.num_frac_delays)

  const outputMeta = { ...meta, filename: outfilename}
  const outputDescriptor = {
    meta: outputMeta,
    repoint: {
      from: origDt,
      to: newDt,
      margin: new Uint16Array(marginResult.buf),
    },
    sections: {
      header: { content: headerResult.buf, type: 'buffer' },
      dt: { content: newDtBin, type: 'buffer' },
      udpmap: { content: udpmapResult.buf, type: 'buffer' },
      margin: { content: marginResult.buf, type: 'buffer' },
      data: { file, type: 'file' },
    },
  }
  const writeResult = await write_subfile(outputDescriptor, opts)
  if(writeResult.status != 'ok')
    return writeResult

  return {status: 'ok'}
}

async function runReplace(infilename: string, outfilename: string, opts) {
  const loadResult = await load_subfile(infilename)
  if(loadResult.status != 'ok') {
    console.error(loadResult.reason)
    return
  }
  const {file, meta} = loadResult

  const headerResult = await read_section('header', file, meta)
  const dtResult =     await read_section('dt', file, meta)
  const udpmapResult = await read_section('udpmap', file, meta)
  const marginResult = await read_section('margin', file, meta)
  if(headerResult.status != 'ok') return headerResult
  if(dtResult.status != 'ok') return dtResult
  if(udpmapResult.status != 'ok') return udpmapResult
  if(marginResult.status != 'ok') return marginResult

  const origMap: SourceMap = Object.fromEntries(meta.sources.map((x, i) => [x, i]))
  const remap: SourceMap = Object.fromEntries(meta.sources.map((x, i) => [x, i]))
  if(opts.replace_map_all != null) {
    for(let [k,v] of Object.entries(remap))
      remap[k] = origMap[opts.replace_map_all]
  } else
    for(let [k,v] of opts.replace_map)
      remap[k] = origMap[v]
  
  
  const outputMeta = { ...meta, filename: outfilename}
  const outputDescriptor = {
    meta: outputMeta,
    remap,
    sections: {
      header: { content: headerResult.buf, type: 'buffer' },
      dt: { content: dtResult.buf, type: 'buffer' },
      udpmap: { content: udpmapResult.buf, type: 'buffer' },
      margin: { content: marginResult.buf, type: 'buffer' },
      data: { file, type: 'file' },
    },
  }
  const writeResult = await write_subfile(outputDescriptor, opts)
  if(writeResult.status != 'ok')
    return writeResult

  return {status: 'ok'}
}



const result: any = await main(process.argv.slice(2)) /*.catch(e => {
  console.error(`ERROR: ${e}`)
})*/

if(result.status != 'ok')
  console.log(`${result.reason}`)